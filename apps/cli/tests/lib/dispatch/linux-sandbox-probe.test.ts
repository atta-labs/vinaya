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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it("falls back to Claude's own output when no tool ran, and names a timeout", () => {
    expect(readClaudeSandboxProbe(run({ exitCode: 1, stderr: 'sandbox failed to start\n' }))).toEqual({
      ok: false,
      error: 'sandbox failed to start'
    })
    expect(readClaudeSandboxProbe(run({ exitCode: null, timedOut: true })).ok).toBe(false)
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

describe('listingRevealsSocket', () => {
  it("flags a listing that names the socket's directory, and not an empty or denied one", () => {
    const socketPath = '/tmp/vinaya-dev-tools/0123456789abcdef/s'
    expect(listingRevealsSocket('LISTED:/tmp/vinaya-dev-tools|0123456789abcdef\n', socketPath)).toBe(true)
    expect(listingRevealsSocket('LISTED:/tmp/vinaya-dev-tools|\n', socketPath)).toBe(false)
    expect(listingRevealsSocket('LIST-DENIED:/tmp/vinaya-dev-tools|EACCES\n', socketPath)).toBe(false)
  })
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
