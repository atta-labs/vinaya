/**
 * The pre-spawn Linux sandbox probe and the host-level Unix-socket opt-in
 * (`apps/cli/specs/isolation.md`, "The Linux sandbox probe and the
 * Unix-socket opt-in").
 *
 * The probe's decisions run here against a fake runner, on any host. The
 * socket proof needs Claude Code's real sandbox on Linux, so it runs only
 * with `VINAYA_SANDBOX_CONFORMANCE=1` on Linux — CI's Linux sandbox job runs
 * the same proof through the conformance suite's socket test.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildClaudeSandboxSettings,
  CLAUDE_SANDBOX_ALLOWED_DOMAINS,
  CLAUDE_SANDBOX_PROBE_COMMAND,
  CLAUDE_SANDBOX_PROBE_PROMPT,
  type ConfinementRequest,
  claudeSandboxProbeArgs,
  LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV,
  linuxUnixSocketFilterOptIn,
  probeAgentSandbox,
  readClaudeSandboxProbe,
  readCodexSandboxProbe,
  resolveClaudeConfinement,
  runRealSandboxProbe,
  SANDBOX_PROBE_MARKER,
  type SandboxProbeRun,
  type SandboxProbeRunner
} from '../../../src/lib/worker-boundary.js'
import { listingRevealsSocket, reachDriverSocketUnderOptIn } from './driver-socket-reach.js'
import { spawnSyncBudgeted, stripVinayaEnv } from '../process-fixture.js'
import { FAKE_CLAUDE_PROBE_ANSWER } from './fake-sandbox-probe.js'

const SECCOMP_ERROR =
  'apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * A PATH made only of a fresh temporary directory holding links to the host
 * tools these tests themselves run — never the host's own PATH minus some
 * directories, which on a host with `bwrap`/`socat` beside `git` and the
 * shell would drop those too. A tool a test needs absent or present is
 * added or left out of the directory it hands the child, never hidden.
 */
const HOST_TOOLS_THE_TESTS_RUN = ['bun', 'git', 'sh', 'which', 'cat', 'touch', 'env', 'node']

function hostToolsPath(): string {
  const dir = tempDir('vinaya-host-tools-')
  const realDirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const tool of HOST_TOOLS_THE_TESTS_RUN) {
    const found = realDirs.map((d) => join(d, tool)).find((p) => existsSync(p))
    if (found) symlinkSync(found, join(dir, tool))
  }
  return dir
}

function request(): ConfinementRequest {
  return {
    role: 'developer',
    agent: 'claude',
    worktreeDir: tempDir('vinaya-probe-wt-'),
    scratchDir: tempDir('vinaya-probe-scratch-'),
    allowedHosts: [...CLAUDE_SANDBOX_ALLOWED_DOMAINS]
  }
}

function run(overrides: Partial<SandboxProbeRun>): SandboxProbeRun {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides }
}

/** A Claude stream-json transcript whose one Bash tool result carries `text`. */
function claudeStream(text: string, isError: boolean): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: CLAUDE_SANDBOX_PROBE_COMMAND } }]
      }
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: isError, content: text }] }
    }),
    JSON.stringify({ type: 'result', result: 'done' })
  ].join('\n')
}

function fakeRunner(result: SandboxProbeRun): {
  runner: SandboxProbeRunner
  calls: Array<Parameters<SandboxProbeRunner>[0]>
} {
  const calls: Array<Parameters<SandboxProbeRunner>[0]> = []
  return {
    calls,
    runner: async (input) => {
      calls.push(input)
      return result
    }
  }
}

describe('linuxUnixSocketFilterOptIn — host-level only', () => {
  const base = { cwd: '/nowhere', readFile: () => null }

  it('is on only on Linux with the variable exactly 1', () => {
    expect(
      linuxUnixSocketFilterOptIn({ ...base, platform: 'linux', env: { [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: '1' } })
    ).toBe(true)
    expect(linuxUnixSocketFilterOptIn({ ...base, platform: 'linux', env: {} })).toBe(false)
    expect(
      linuxUnixSocketFilterOptIn({
        ...base,
        platform: 'linux',
        env: { [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: 'true' }
      })
    ).toBe(false)
    expect(
      linuxUnixSocketFilterOptIn({ ...base, platform: 'linux', env: { [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: '0' } })
    ).toBe(false)
  })

  it('is never on macOS, even with the variable set', () => {
    expect(
      linuxUnixSocketFilterOptIn({ ...base, platform: 'darwin', env: { [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: '1' } })
    ).toBe(false)
  })

  it('ignores the variable when an env file Bun loads from the working directory sets it', () => {
    const cwd = tempDir('vinaya-probe-envfile-')
    writeFileSync(join(cwd, '.env'), `OTHER=x\nexport ${LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV}=1\n`)
    const readFile = (path: string): string | null => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    }
    expect(
      linuxUnixSocketFilterOptIn({
        cwd,
        readFile,
        platform: 'linux',
        env: { [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: '1' }
      })
    ).toBe(false)
    rmSync(join(cwd, '.env'))
    writeFileSync(join(cwd, '.env.local'), `OTHER=${LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV}\n`)
    expect(
      linuxUnixSocketFilterOptIn({
        cwd,
        readFile,
        platform: 'linux',
        env: { [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: '1' }
      })
    ).toBe(true)
  })

  it('ignores it for every env file Bun could load, whatever NODE_ENV is, and any other .env* file', () => {
    const readFile = (path: string): string | null => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    }
    for (const file of ['.env.development', '.env.development.local', '.env.production', '.env.test', '.env.staging']) {
      const cwd = tempDir('vinaya-probe-envmode-')
      writeFileSync(join(cwd, file), `${LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV}=1\n`)
      for (const env of [{}, { NODE_ENV: 'production' }]) {
        expect(
          linuxUnixSocketFilterOptIn({
            cwd,
            readFile,
            platform: 'linux',
            env: { ...env, [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: '1' }
          }),
          `${file} with NODE_ENV=${(env as { NODE_ENV?: string }).NODE_ENV ?? 'unset'}`
        ).toBe(false)
      }
    }
  })
})

describe('the opt-in sets allowAllUnixSockets and nothing else', () => {
  it('adds only network.allowAllUnixSockets to the settings', () => {
    const req = request()
    const plain = buildClaudeSandboxSettings(req)
    const optedIn = buildClaudeSandboxSettings(req, { allowAllUnixSockets: true })
    expect(plain.sandbox.network.allowAllUnixSockets).toBeUndefined()
    expect(optedIn.sandbox.network.allowAllUnixSockets).toBe(true)
    const { allowAllUnixSockets: _dropped, ...optedInNetwork } = optedIn.sandbox.network
    expect({ ...optedIn, sandbox: { ...optedIn.sandbox, network: optedInNetwork } }).toEqual(plain)
  })

  it('reaches the settings on a confined Linux dispatch with the opt-in, and says the filter is off', () => {
    const result = resolveClaudeConfinement(request(), {
      platform: 'linux',
      linuxTools: { available: true, missing: [] },
      developerDir: null,
      unixSocketFilterOptIn: true
    })
    expect(result.confined).toBe(true)
    if (!result.confined) return
    expect(result.unixSocketFilterOff).toBe(true)
    expect(result.settings.sandbox.network.allowAllUnixSockets).toBe(true)
    expect(result.settings.sandbox.allowUnsandboxedCommands).toBe(false)
    expect(result.settings.sandbox.failIfUnavailable).toBe(true)
  })

  it('never reaches the settings on Linux without the opt-in, or on macOS even when asked', () => {
    for (const deps of [
      { platform: 'linux' as const, unixSocketFilterOptIn: false },
      { platform: 'darwin' as const, unixSocketFilterOptIn: true }
    ]) {
      const result = resolveClaudeConfinement(request(), {
        ...deps,
        linuxTools: { available: true, missing: [] },
        developerDir: null
      })
      expect(result.confined).toBe(true)
      if (!result.confined) continue
      expect(result.unixSocketFilterOff).toBe(false)
      expect(result.settings.sandbox.network.allowAllUnixSockets).toBeUndefined()
    }
  })
})

describe('readClaudeSandboxProbe — judged from the Bash tool result, never the model', () => {
  it('passes when a non-error tool result carries the marker', () => {
    expect(readClaudeSandboxProbe(run({ stdout: claudeStream(`${SANDBOX_PROBE_MARKER}\n`, false) }))).toEqual({
      ok: true
    })
  })

  it("fails quoting the sandbox's own error from the tool result", () => {
    const result = readClaudeSandboxProbe(run({ stdout: claudeStream(SECCOMP_ERROR, true) }))
    expect(result).toEqual({ ok: false, error: SECCOMP_ERROR })
  })

  it('does not pass on an error tool result, even one that prints the marker', () => {
    const result = readClaudeSandboxProbe(run({ stdout: claudeStream(`${SANDBOX_PROBE_MARKER}\nexit 1`, true) }))
    expect(result.ok).toBe(false)
  })

  it('does not pass when only the model says the marker', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: SANDBOX_PROBE_MARKER }] } }),
      JSON.stringify({ type: 'result', result: SANDBOX_PROBE_MARKER })
    ].join('\n')
    expect(readClaudeSandboxProbe(run({ stdout })).ok).toBe(false)
  })

  it("says the sandbox could not be confirmed when no tool ran, quoting Claude's own output, and names a timeout", () => {
    expect(readClaudeSandboxProbe(run({ exitCode: 1, stderr: 'Invalid API key\n' }))).toEqual({
      ok: false,
      noCommandRan: true,
      error: 'Claude ran no Bash command, so the sandbox could not be confirmed to run one: Invalid API key'
    })
    const timedOut = readClaudeSandboxProbe(run({ exitCode: null, timedOut: true }))
    expect(timedOut.ok).toBe(false)
    if (!timedOut.ok) expect(timedOut.noCommandRan).toBeUndefined()
  })
})

describe('readCodexSandboxProbe', () => {
  it('passes on exit 0 with the marker, and quotes stderr otherwise', () => {
    expect(readCodexSandboxProbe(run({ stdout: `${SANDBOX_PROBE_MARKER}\n` }))).toEqual({ ok: true })
    expect(
      readCodexSandboxProbe(run({ exitCode: 1, stderr: 'bwrap: setting up uid map: Permission denied\n' }))
    ).toEqual({ ok: false, error: 'bwrap: setting up uid map: Permission denied' })
    expect(readCodexSandboxProbe(run({ exitCode: 0, stdout: '' })).ok).toBe(false)
  })
})

describe('probeAgentSandbox — one command through the real sandbox, Linux only', () => {
  it('runs Claude in print mode with the dispatch settings file, the Bash tool only and no MCP server', async () => {
    const fake = fakeRunner(run({ stdout: claudeStream(SANDBOX_PROBE_MARKER, false) }))
    const result = await probeAgentSandbox(
      { agent: 'claude', binaryPath: '/bin/claude', cwd: '/wt', env: { HOME: '/h' }, settingsPath: '/s/settings.json' },
      { platform: 'linux', run: fake.runner }
    )
    expect(result).toEqual({ ok: true })
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]!
    expect(call.command).toBe('/bin/claude')
    expect(call.args).toEqual(claudeSandboxProbeArgs('/s/settings.json'))
    expect(call.args.slice(call.args.indexOf('--settings'), call.args.indexOf('--settings') + 2)).toEqual([
      '--settings',
      '/s/settings.json'
    ])
    expect(call.args).toContain('--strict-mcp-config')
    expect(call.args.slice(call.args.indexOf('--tools'), call.args.indexOf('--tools') + 2)).toEqual(['--tools', 'Bash'])
    expect(call.stdin).toBe(CLAUDE_SANDBOX_PROBE_PROMPT)
    expect(call.cwd).toBe('/wt')
    expect(call.env).toEqual({ HOME: '/h' })
  })

  it('refuses a Claude dispatch quoting the apply-seccomp error', async () => {
    const fake = fakeRunner(run({ stdout: claudeStream(SECCOMP_ERROR, true) }))
    const result = await probeAgentSandbox(
      { agent: 'claude', binaryPath: 'claude', cwd: '/wt', env: {}, settingsPath: '/s.json' },
      { platform: 'linux', run: fake.runner }
    )
    expect(result).toEqual({ ok: false, error: SECCOMP_ERROR })
    expect(fake.calls).toHaveLength(1)
  })

  it('tries once more when the turn ran no command, and passes if the second turn does', async () => {
    const outputs = [
      run({ exitCode: 1, stderr: 'overloaded' }),
      run({ stdout: claudeStream(SANDBOX_PROBE_MARKER, false) })
    ]
    const calls: unknown[] = []
    const result = await probeAgentSandbox(
      { agent: 'claude', binaryPath: 'claude', cwd: '/wt', env: {}, settingsPath: '/s.json' },
      {
        platform: 'linux',
        run: async (input) => {
          calls.push(input)
          return outputs.shift()!
        }
      }
    )
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it('refuses after two turns that ran no command, saying the sandbox could not be confirmed', async () => {
    const fake = fakeRunner(run({ exitCode: 1, stderr: 'model not found' }))
    const result = await probeAgentSandbox(
      { agent: 'claude', binaryPath: 'claude', cwd: '/wt', env: {}, settingsPath: '/s.json' },
      { platform: 'linux', run: fake.runner }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('could not be confirmed')
    expect(fake.calls).toHaveLength(2)
  })

  it("runs Codex through `codex sandbox` with the staged sandbox mode and the dispatch's writable roots", async () => {
    const fake = fakeRunner(run({ stdout: `${SANDBOX_PROBE_MARKER}\n` }))
    const result = await probeAgentSandbox(
      {
        agent: 'codex',
        binaryPath: '/bin/codex',
        cwd: '/wt',
        env: { CODEX_HOME: '/staged/codex-home' },
        configToml: 'sandbox_mode = "workspace-write"\n',
        withWritableDirs: (args) => [...args, '--config', 'sandbox_workspace_write.writable_roots=["/scratch"]']
      },
      { platform: 'linux', run: fake.runner }
    )
    expect(result).toEqual({ ok: true })
    expect(fake.calls[0]!.args).toEqual([
      'sandbox',
      '--config',
      'sandbox_mode="workspace-write"',
      '--config',
      'sandbox_workspace_write.writable_roots=["/scratch"]',
      '--',
      'echo',
      SANDBOX_PROBE_MARKER
    ])
    expect(fake.calls[0]!.env).toEqual({ CODEX_HOME: '/staged/codex-home' })
  })

  it("refuses a Codex dispatch quoting the sandbox's error, or a config with no sandbox mode", async () => {
    const failing = fakeRunner(run({ exitCode: 1, stderr: 'bwrap: No permissions to create new namespace' }))
    expect(
      await probeAgentSandbox(
        {
          agent: 'codex',
          binaryPath: 'codex',
          cwd: '/wt',
          env: {},
          configToml: 'sandbox_mode = "workspace-write"\n',
          withWritableDirs: (a) => [...a]
        },
        { platform: 'linux', run: failing.runner }
      )
    ).toEqual({ ok: false, error: 'bwrap: No permissions to create new namespace' })
    const unused = fakeRunner(run({}))
    const noMode = await probeAgentSandbox(
      { agent: 'codex', binaryPath: 'codex', cwd: '/wt', env: {}, configToml: '', withWritableDirs: (a) => [...a] },
      { platform: 'linux', run: unused.runner }
    )
    expect(noMode.ok).toBe(false)
    expect(unused.calls).toHaveLength(0)
  })

  it('runs nothing off Linux', async () => {
    const fake = fakeRunner(run({ exitCode: 1, stderr: 'should not run' }))
    for (const platform of ['darwin', 'win32'] as const) {
      expect(
        await probeAgentSandbox(
          { agent: 'claude', binaryPath: 'claude', cwd: '/wt', env: {}, settingsPath: '/s.json' },
          { platform, run: fake.runner }
        )
      ).toEqual({ ok: true })
    }
    expect(fake.calls).toHaveLength(0)
  })
})

describe('runRealSandboxProbe', () => {
  it('captures output and exit status, feeds stdin, and kills at the budget', async () => {
    const ok = await runRealSandboxProbe({
      command: '/bin/sh',
      args: ['-c', 'cat; echo err >&2; exit 3'],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH },
      stdin: 'hello',
      timeoutMs: 10_000
    })
    expect(ok).toEqual({ exitCode: 3, stdout: 'hello', stderr: 'err\n', timedOut: false })
    const slow = await runRealSandboxProbe({
      command: '/bin/sh',
      args: ['-c', 'sleep 5'],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH },
      stdin: '',
      timeoutMs: 200
    })
    expect(slow.timedOut).toBe(true)
    const missing = await runRealSandboxProbe({
      command: join(tmpdir(), 'no-such-agent-binary'),
      args: [],
      cwd: tmpdir(),
      env: {},
      stdin: '',
      timeoutMs: 1_000
    })
    expect(missing.exitCode).not.toBe(0)
  })
})

describe('the fake vendor fixtures answer the probe as a working sandbox would', () => {
  it('passes the probe through a fake claude without recording a call', async () => {
    const dir = tempDir('vinaya-probe-fake-')
    const marker = join(dir, 'recorded')
    const fake = join(dir, 'claude')
    writeFileSync(fake, `#!/bin/sh\n${FAKE_CLAUDE_PROBE_ANSWER}touch "${marker}"\ncat > /dev/null\nexit 0\n`)
    chmodSync(fake, 0o755)
    const result = await probeAgentSandbox(
      {
        agent: 'claude',
        binaryPath: fake,
        cwd: dir,
        env: { PATH: process.env.PATH },
        settingsPath: join(dir, 's.json')
      },
      { platform: 'linux', run: runRealSandboxProbe }
    )
    expect(result).toEqual({ ok: true })
    expect(existsSync(marker)).toBe(false)
  })
})

describe('listingRevealsSocket', () => {
  it("flags a listing that names the socket's directory, and not an empty or denied one", () => {
    const socketPath = '/tmp/vinaya-dev-tools/0123456789abcdef/s'
    expect(listingRevealsSocket('LISTED:/tmp/vinaya-dev-tools|0123456789abcdef\n', socketPath)).toBe(true)
    expect(listingRevealsSocket('LISTED:/tmp/vinaya-dev-tools|\n', socketPath)).toBe(false)
    expect(listingRevealsSocket('LIST-DENIED:/tmp/vinaya-dev-tools|EACCES\n', socketPath)).toBe(false)
  })
})

/**
 * `dispatchRole` end to end, through the probe. A child process presents
 * itself as Linux before it imports `dispatch.ts`, with stub `bwrap`/`socat`
 * and a fake `claude` on `PATH`, so the real confinement, settings file,
 * probe, refusal and log run on any host. The fake answers the probe call
 * (its argv names the marker command) as the test asks, and records every
 * call in order.
 */
describe('dispatchRole runs the probe before spawn on Linux', () => {
  const DISPATCH_LIB = join(import.meta.dir, '..', '..', '..', 'src', 'lib', 'dispatch.ts')

  type ProbeOutcome = 'sandbox-error' | 'pass'

  function runDispatch(outcome: ProbeOutcome, extraEnv: Record<string, string> = {}) {
    const home = tempDir('vinaya-probe-e2e-home-')
    const cwd = tempDir('vinaya-probe-e2e-cwd-')
    const binDir = tempDir('vinaya-probe-e2e-bin-')
    const calls = join(cwd, 'calls.log')
    const promptFile = join(cwd, 'prompt.txt')
    const resultFile = join(cwd, 'result.json')
    writeFileSync(promptFile, 'do the thing')
    for (const tool of ['bwrap', 'socat']) {
      writeFileSync(join(binDir, tool), '#!/bin/sh\nexit 0\n')
      chmodSync(join(binDir, tool), 0o755)
    }
    const probeAnswer =
      outcome === 'pass'
        ? FAKE_CLAUDE_PROBE_ANSWER.replace('cat > /dev/null;', `echo "probe $*" >> "${calls}"; cat > /dev/null;`)
        : `case "$*" in *${SANDBOX_PROBE_MARKER}*) echo "probe $*" >> "${calls}"; cat > /dev/null; printf '%s\\n' '${JSON.stringify(
            { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: SECCOMP_ERROR }] } }
          )}'; exit 0;; esac\n`
    writeFileSync(
      join(binDir, 'claude'),
      `#!/bin/sh\n${probeAnswer}echo spawn >> "${calls}"\ncat > /dev/null\nprintf '%s' '{"session_id":"s","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    chmodSync(join(binDir, 'claude'), 0o755)
    const script = join(cwd, 'dispatch.ts')
    writeFileSync(
      script,
      [
        "import { writeFileSync } from 'node:fs'",
        "Object.defineProperty(process, 'platform', { value: 'linux' })",
        `const { dispatchRole } = await import(${JSON.stringify(DISPATCH_LIB)})`,
        "const result = await dispatchRole('developer', 'claude', 'probe', {",
        `  promptFile: ${JSON.stringify(promptFile)},`,
        `  cwd: ${JSON.stringify(cwd)},`,
        '  unattended: true',
        '})',
        `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result))`
      ].join('\n')
    )
    const child = spawnSyncBudgeted(
      'bun',
      [script],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...stripVinayaEnv(process.env),
          HOME: home,
          PATH: `${binDir}:${hostToolsPath()}`,
          ...extraEnv
        }
      },
      30_000,
      'dispatchRole probe fixture'
    )
    // Simulated host fact: Linux with stand-in bwrap/socat/claude only in binDir, and no other vendor tool on PATH.
    expect(child.status, `host fact simulated: linux with stand-in bwrap/socat/claude only; ${child.stderr}`).toBe(0)
    const logPath = join(home, '.vinaya', 'runtime', 'unresolved', 'logs', 'unresolved', 'none.ndjson')
    return {
      stderr: child.stderr,
      result: JSON.parse(readFileSync(resultFile, 'utf8')) as {
        failureReason?: string
        exitCode: number | null
        sandboxProbeRefusal?: { agent: string; error: string }
      },
      calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
      log: (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n') : [])
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as { kind?: string; event?: string; operation?: string; result?: string; target?: string }
        )
    }
  }

  function settingsOf(probeCall: string): { sandbox: { network: { allowAllUnixSockets?: boolean } } } {
    const settingsPath = probeCall.split(' ')[probeCall.split(' ').indexOf('--settings') + 1] as string
    return JSON.parse(readFileSync(settingsPath, 'utf8'))
  }

  it("refuses before the agent starts, quoting the sandbox's error, and logs the probe failure", () => {
    const run = runDispatch('sandbox-error')
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]).toStartWith('probe ')
    expect(run.calls[0]).toContain('--settings')
    expect(run.result.failureReason).toBe('refused')
    expect(run.result.exitCode).toBeNull()
    // Typed beside the shared reason, so the loop classifies it without reading the line below.
    expect(run.result.sandboxProbeRefusal?.agent).toBe('claude')
    expect(run.result.sandboxProbeRefusal?.error).toContain(SECCOMP_ERROR)
    expect(run.stderr).toContain("refused — claude's sandbox could not run a probe command on this host")
    expect(run.stderr).toContain(SECCOMP_ERROR)
    const probeLine = run.log.find((l) => l.kind === 'operation' && l.operation === 'linux-sandbox-probe')
    expect(probeLine).toMatchObject({ event: 'completed', result: 'unavailable', target: 'claude' })
    expect(run.log.find((l) => l.event === 'dispatch_failed')).toBeDefined()
    expect(run.log.find((l) => l.event === 'dispatched')).toBeUndefined()
  }, 40_000)

  it('spawns the agent only after the probe passes, with the filter on when the variable is unset', () => {
    const run = runDispatch('pass')
    expect(run.calls.map((c) => c.split(' ')[0])).toEqual(['probe', 'spawn'])
    expect(settingsOf(run.calls[0] as string).sandbox.network.allowAllUnixSockets).toBeUndefined()
    expect(run.stderr).not.toContain('Unix-socket filter is off')
    expect(run.result.failureReason).toBeUndefined()
    expect(run.result.sandboxProbeRefusal).toBeUndefined()
    expect(run.log.find((l) => l.event === 'dispatched')).toBeDefined()
    expect(run.log.find((l) => l.operation === 'linux-sandbox-probe')).toBeUndefined()
  }, 40_000)

  it('with the host variable set, says the filter is off, probes with allowAllUnixSockets, then spawns', () => {
    const run = runDispatch('pass', { [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: '1' })
    expect(run.stderr).toContain(
      `the sandbox's Unix-socket filter is off on this host (${LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV}=1)`
    )
    expect(run.calls.map((c) => c.split(' ')[0])).toEqual(['probe', 'spawn'])
    expect(settingsOf(run.calls[0] as string).sandbox.network.allowAllUnixSockets).toBe(true)
  }, 40_000)
})

const LIVE = process.env.VINAYA_SANDBOX_CONFORMANCE === '1' && process.platform === 'linux'

describe.skipIf(!LIVE)('with the opt-in set, a sandboxed shell cannot reach the driver sockets', () => {
  it('can neither list the driver-tool socket directory nor connect to a live socket in it', async () => {
    const reach = await reachDriverSocketUnderOptIn()
    expect(reach.settings.sandbox.network.allowAllUnixSockets).toBe(true)
    expect(reach.status, reach.stderr).toBe(0)
    expect(reach.stdout).toMatch(/LIST(ED|-DENIED):/)
    expect(listingRevealsSocket(reach.stdout, reach.socketPath)).toBe(false)
    expect(reach.stdout).toMatch(/DENIED:(EACCES|EPERM|ENOENT)/)
    expect(reach.stdout).not.toContain('CONNECTED')
    expect(reach.connectionsAfter).toBe(reach.connectionsBefore)
  }, 60_000)
})
