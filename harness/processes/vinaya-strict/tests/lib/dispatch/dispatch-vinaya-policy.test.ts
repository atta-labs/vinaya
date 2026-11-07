/**
 * `dispatchRole`'s spawn/timeout/attribution behavior (task 3,
 * `vinaya-log-v1`, Issue #406) — exercised through the real `vinaya dispatch`
 * CLI entry point (`execFileSync('bun', [INDEX, ...])`, same discipline as
 * `apps/cli/tests/commands/issue.test.ts`'s fake `gh`), never by importing
 * `dispatchRole` in-process: `harness/processes/vinaya-strict/integration/config/compose.ts`'s
 * `GLOBAL_VINAYA_HOME` is a module-level constant frozen at first import from
 * whatever `HOME` happens to be, and `@attalabs/aeg-forge-state`'s
 * `resolveRepo()` caches its result for the process lifetime — an in-process
 * `bun:test` run sharing either with another test file in the same run could
 * silently pollute the real developer machine's own `~/.vinaya/outbox/` or
 * read a stale cached repo. A fresh subprocess per test sidesteps both: a
 * scratch `HOME`, and a scratch, non-git `cwd` so `resolveRepo()` resolves
 * `null` (the `unresolved/` outbox bucket) every time.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync, spawn, execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import {
  identifyVendorFromModelShape,
  resolveClassModel,
  buildRolePermissions,
  buildCodexExecpolicyRules,
  buildWriteAccessScope,
  writeAccessHookScript,
  addCodexWritableDirs,
  PERMISSION_POLICY_VERSION,
  codexSpawnEnvExtras,
  REVIEWER_RESUME_REFUSED_REASON,
  isReviewerResume,
  confinedTurboEnv
} from '../../../loops/dev-review/dispatch/dispatch.js'
import {
  agentConfigProtectedSubpaths,
  resolveOpenedAgentConfigPaths
} from '../../../../../kernel/isolation/worker-boundary.js'
import { surfaceOpenedAgentConfigPaths } from '../../../loops/dev-review/standalone/dev-review-loop.js'
import { PROGRAMS, programCommandLine, programForBin } from '../../../tools/programs.js'
import { parse as parseYaml } from 'yaml'
import { devToolsSocketRoot } from '../../../../../kernel/tools/dev-tools-registration.js'
import {
  CLI_ROOT,
  INDEX,
  pathWithoutRealVendors,
  collectLaunchedChildren,
  killLaunchedChild,
  stripVinayaEnv,
  runDispatch,
  runScriptWithBudget,
  spawnBudgeted,
  writeFakeBinary,
  outboxLines,
  PROMPT_FILE_CONTENT,
  readArgv,
  withoutTurnResultFlag
} from './dispatch-fixtures.js'

/**
 * The process-hygiene proof the child-process file carries, for this file's own fake-vendor launches: the
 * host's `vinaya-dispatch-bin-` processes are read before any test here runs, and the last case below asserts
 * none is new. Each file keeps its own snapshot, so a leak is caught in the file that made it.
 */
function vendorProcessSurvivors(): string[] {
  const out = execSync('ps -eo pid,command | grep "vinaya-dispatch-bin-" | grep -v grep || true', {
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL'
  }).trim()
  if (out.length === 0) return []
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

let preExistingVendorSurvivors: Set<string> = new Set()
beforeAll(() => {
  preExistingVendorSurvivors = new Set(vendorProcessSurvivors())
})
const tempDirs: string[] = []
afterEach(() => {
  // O1: unconditional — runs whether the test above passed, failed, or hit
  // its own subprocess budget, since `afterEach` fires regardless of how the
  // test body exited.
  for (const dir of tempDirs.splice(0)) {
    for (const child of collectLaunchedChildren(dir)) killLaunchedChild(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  // The real path: macOS reaches its temporary directory through a symlink, and
  // tests that compare paths must see the same spelling the product resolves to.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

describe('addCodexWritableDirs — reviewer hand-off directories', () => {
  it('adds each realpath-resolved directory before the JSONL prompt flags on a fresh exec', () => {
    const a = tempDir('vinaya-codex-write-a-')
    const b = tempDir('vinaya-codex-write-b-')
    expect(addCodexWritableDirs(['exec', '--sandbox', 'workspace-write', '--json', '-'], [a, b], false)).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      realpathSync(a),
      '--add-dir',
      realpathSync(b),
      '--json',
      '-'
    ])
  })

  it('uses a sandbox writable-roots config override for codex exec resume', () => {
    const dir = tempDir('vinaya-codex-write-resume-')
    const argv = ['exec', 'resume', 'thread-id', '--json', '-']
    expect(addCodexWritableDirs(argv, [dir], true)).toEqual([
      'exec',
      'resume',
      'thread-id',
      '--config',
      `sandbox_workspace_write.writable_roots=${JSON.stringify([realpathSync(dir)])}`,
      '--json',
      '-'
    ])
  })

  it('grants only the real parent of a resumed developer artifact and de-duplicates it', () => {
    const dir = tempDir('vinaya-codex-developer-file-')
    const confidence = join(dir, 'granted-one.txt')
    const response = join(dir, 'granted-two.txt')
    const argv = ['exec', 'resume', 'thread-id', '--json', '-']
    expect(addCodexWritableDirs(argv, [], true, [confidence, response])).toEqual([
      'exec',
      'resume',
      'thread-id',
      '--config',
      `sandbox_workspace_write.writable_roots=${JSON.stringify([realpathSync(dir)])}`,
      '--json',
      '-'
    ])
  })
})

/**
 * O1/O2/O4 (Issue #456). A caller-named model reaches the chosen vendor
 * through that vendor's own `--model` flag, the log records the model
 * rather than the vendor, and a model shaped for a different vendor is
 * refused before any spawn.
 */
describe('dispatchRole — model selection (O1/O2/O4, #456)', () => {
  const MODEL_ARGV_FIXTURES: Array<{ agent: 'claude' | 'codex'; model: string; argv: string[] }> = [
    {
      agent: 'claude',
      model: 'opus',
      argv: ['-p', '--verbose', '--output-format', 'stream-json', '--model', 'opus']
    },
    {
      agent: 'codex',
      model: 'gpt-5.6-sol',
      argv: [
        'exec',
        '--sandbox',
        'workspace-write',
        '--strict-config',
        '--dangerously-bypass-hook-trust',
        '--skip-git-repo-check',
        '--model',
        'gpt-5.6-sol',
        '--json',
        '-'
      ]
    }
  ]

  for (const fixture of MODEL_ARGV_FIXTURES) {
    it(`${fixture.agent}: --model reaches the child as that vendor's own --model flag (O1)`, () => {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      const argvOut = join(cwd, 'argv.out')
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)
      writeFakeBinary(
        binDir,
        fixture.agent,
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
      )

      const r = runDispatch(
        ['developer', '--agent', fixture.agent, '--prompt-file', promptFile, '--model', fixture.model],
        cwd,
        home,
        `${binDir}:${pathWithoutRealVendors()}`
      )
      expect(r.status).toBe(0)
      // O1 (#543): claude alone gets a trailing `--settings <path>` pair.
      const actualArgv = readArgv(argvOut)
      if (fixture.agent === 'claude') {
        expect(actualArgv.slice(-2, -1)).toEqual(['--settings'])
        expect(withoutTurnResultFlag(actualArgv.slice(0, -2), '--json-schema')).toEqual(fixture.argv)
      } else if (fixture.agent === 'codex') {
        expect(withoutTurnResultFlag(actualArgv, '--output-schema')).toEqual(fixture.argv)
      } else {
        expect(actualArgv).toEqual(fixture.argv)
      }
    })
  }

  it('no --model given: the vendor sees no --model flag at all, same argv as before this task', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    // O1 (#543): claude alone gets a trailing `--settings <path>` pair.
    const actualArgv = readArgv(argvOut)
    expect(actualArgv.slice(-2, -1)).toEqual(['--settings'])
    expect(withoutTurnResultFlag(actualArgv.slice(0, -2), '--json-schema')).toEqual([
      '-p',
      '--verbose',
      '--output-format',
      'stream-json'
    ])
  })

  it('O2: dispatched records the requested model as a marked request label, never bare (no receipt possible yet)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--model', 'claude-opus-5'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const dispatched = lines.find((l) => l.event === 'dispatched')
    expect((dispatched as { model: string }).model).toBe('requested:claude-opus-5')
  })

  it('O2: outcome_received records the VENDOR-REPORTED model, not the requested one, when they differ', () => {
    // This is the live bug O2 closes: the fake binary was asked for
    // `claude-opus-5` but its own `modelUsage` receipt says `claude-opus-6`
    // actually ran — the ledger must say what ran, not what was asked for.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"usage":{"input_tokens":1,"output_tokens":1},"modelUsage":{"claude-opus-6":{"canonicalModel":"claude-opus-6"}}}'\nexit 0\n`
    )

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--model', 'claude-opus-5'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const dispatched = lines.find((l) => l.event === 'dispatched')
    const outcome = lines.find((l) => l.event === 'outcome_received')
    // Pre-completion, still just the request label — no receipt exists yet.
    expect((dispatched as { model: string }).model).toBe('requested:claude-opus-5')
    // Post-completion, the vendor's own bare, unprefixed receipt wins.
    expect((outcome as { model: string }).model).toBe('claude-opus-6')
  })

  it('O2: outcome_received falls back to the marked request label when the vendor emits no receipt', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    // No `modelUsage` field at all — Codex's own real shape, and what any
    // vendor's stdout looks like before it ever reports a model receipt.
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--model', 'claude-opus-5'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const outcome = (outboxLines(home, 'none') as Array<Record<string, unknown>>).find(
      (l) => l.event === 'outcome_received'
    )
    // Marked as a request, not presented as a confirmed observation.
    expect((outcome as { model: string }).model).toBe('requested:claude-opus-5')
  })

  for (const role of ['code-reviewer', 'security'] as const) {
    it(`a ${role} dispatch that asks to resume a session is refused before any spawn — a reviewer runs only on a fresh session`, () => {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)
      // A binary that would prove it was spawned if it ever ran.
      const spawnedMarker = join(cwd, 'spawned')
      writeFakeBinary(binDir, 'claude', `#!/bin/sh\ntouch "${spawnedMarker}"\ncat > /dev/null\necho '{}'\nexit 0\n`)

      const r = spawnBudgeted(
        [
          ...(programCommandLine(['dispatch']) as string[]),
          role,
          '--agent',
          'claude',
          '--prompt-file',
          promptFile,
          '--resume',
          'earlier-session'
        ],
        {
          encoding: 'utf8',
          cwd,
          env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
        },
        'vinaya dispatch'
      )
      expect(r.status).toBe(1)
      expect(existsSync(spawnedMarker)).toBe(false)
      expect(r.stderr).toContain(REVIEWER_RESUME_REFUSED_REASON)
      const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
      const dispatchLine = lines.find((l) => l.kind === 'dispatch')
      expect(dispatchLine?.event).toBe('dispatch_failed')
      expect((dispatchLine as { reason: string }).reason).toBe('refused')
    })
  }

  it('isReviewerResume: only a code or security reviewer asking for a session is a reviewer resume', () => {
    expect(isReviewerResume('code-reviewer', 'sess')).toBe(true)
    expect(isReviewerResume('security', 'sess')).toBe(true)
    expect(isReviewerResume('code-reviewer', undefined)).toBe(false)
    expect(isReviewerResume('developer', 'sess')).toBe(false)
  })

  it('O4: a Claude-shaped model passed to codex is refused before any spawn, naming the vendor and the mismatch', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    // A binary that would prove it was spawned if it ever ran.
    const spawnedMarker = join(cwd, 'spawned')
    writeFakeBinary(binDir, 'codex', `#!/bin/sh\ntouch "${spawnedMarker}"\ncat > /dev/null\necho '{}'\nexit 0\n`)

    const r = spawnBudgeted(
      [
        ...(programCommandLine(['dispatch']) as string[]),
        'developer',
        '--agent',
        'codex',
        '--prompt-file',
        promptFile,
        '--model',
        'claude-opus-5'
      ],
      {
        encoding: 'utf8',
        cwd,
        env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
      },
      'vinaya dispatch'
    )
    expect(r.status).toBe(1)
    expect(existsSync(spawnedMarker)).toBe(false)
    expect(r.stderr).toContain('claude')
    expect(r.stderr).toContain('codex does not accept it')

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    expect(lines).toHaveLength(3)
    const dispatchLine = lines.find((l) => l.kind === 'dispatch')
    expect(dispatchLine?.event).toBe('dispatch_failed')
    expect((dispatchLine as { reason: string }).reason).toBe('refused')
    expect((dispatchLine as { model: string }).model).toBe('requested:claude-opus-5')
  })

  it('a same-vendor model, and a vendor with no known naming convention (codex), are never refused for their shape', () => {
    expect(identifyVendorFromModelShape('claude-sonnet-5')).toBe('claude')
    expect(identifyVendorFromModelShape('sonnet')).toBe('claude')
    // Codex publishes no naming convention to detect — never treated as a
    // shape, only as a vendor a wrongly-shaped model can be refused FROM.
    expect(identifyVendorFromModelShape('gpt-5.6-sol')).toBeNull()
    expect(identifyVendorFromModelShape('o3')).toBeNull()
    expect(identifyVendorFromModelShape('some-random-string')).toBeNull()
  })

  it('O3: class resolution is a verified, non-stale table for Claude, and deliberately empty for Codex', () => {
    expect(resolveClassModel('claude', 'high')).toBe('opus')
    expect(resolveClassModel('claude', 'mid')).toBe('sonnet')
    expect(resolveClassModel('claude', 'fast')).toBe('haiku')
    // No non-stale alias layer exists for either vendor (verified against
    // each CLI's own --help, see `VendorSpec`'s doc comment) — never a
    // guessed, version-pinned model name.
    expect(resolveClassModel('codex', 'high')).toBeNull()
  })
})

describe('dispatchRole — O1 (#543): background-execution deny rule', () => {
  it('wires --settings into a claude dispatch, whose hook denies a Bash call with run_in_background:true and is silent otherwise', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    expect(settingsIdx).toBeGreaterThan(-1)
    const settingsPath = argv[settingsIdx + 1] as string
    expect(existsSync(settingsPath)).toBe(true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> }
    }

    // Dispatch's own execution posture rides on the settings file
    // itself — no operator export required.
    expect(settings.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
    expect(Number(settings.env.BASH_MAX_TIMEOUT_MS)).toBeGreaterThan(600000)
    // O6 (issue-706): the default equals the maximum, from the SAME written
    // value, so a command naming no timeout of its own (a `git push` behind
    // a slow pre-push hook) is never killed at the client's own 2-minute
    // default and retried.
    expect(settings.env.BASH_DEFAULT_TIMEOUT_MS).toBe(settings.env.BASH_MAX_TIMEOUT_MS)

    const preToolUse = settings.hooks.PreToolUse
    // Issue #663 adds a second entry (`Write|Edit`, the write-access grant) —
    // a developer dispatch always carries one, since a directory scope is
    // never null for this role. This block only cares about the first.
    expect(preToolUse.length).toBeGreaterThanOrEqual(1)
    expect(preToolUse[0]?.matcher).toBe('Bash|Agent|Task')
    expect(preToolUse[0]?.hooks[0]?.type).toBe('command')
    const hookCommand = preToolUse[0]?.hooks[0]?.command as string
    expect(hookCommand).toMatch(/^bun "/)

    // Behavioral proof, not just structural: actually run the referenced
    // hook script both ways.
    const scriptPath = hookCommand.slice('bun "'.length, -1)
    const denied = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sleep 100', run_in_background: true } }),
        encoding: 'utf8'
      },
      'PreToolUse hook'
    )
    expect(denied.status).toBe(0)
    const deniedOut = JSON.parse(denied.stdout) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string }
    }
    expect(deniedOut.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(deniedOut.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(deniedOut.hookSpecificOutput.permissionDecisionReason).toMatch(/foreground/)

    const allowed = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi', run_in_background: false } }),
        encoding: 'utf8'
      },
      'PreToolUse hook'
    )
    expect(allowed.status).toBe(0)
    expect(allowed.stdout.trim()).toBe('')

    const nonBash = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }),
        encoding: 'utf8'
      },
      'PreToolUse hook'
    )
    expect(nonBash.status).toBe(0)
    expect(nonBash.stdout.trim()).toBe('')
  })

  it('denies a Bash call running a test runner with no test-file argument, naming the selected-tests rule and CI', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
    }
    const hookCommand = settings.hooks.PreToolUse[0]?.hooks[0]?.command as string
    const scriptPath = hookCommand.slice('bun "'.length, -1)

    const run = (command: string) => {
      const result = spawnBudgeted(
        [scriptPath],
        {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command, run_in_background: false } }),
          encoding: 'utf8'
        },
        'PreToolUse hook'
      )
      expect(result.status).toBe(0)
      return result.stdout.trim()
    }
    const decision = (out: string): { permissionDecision: string; permissionDecisionReason: string } | null =>
      out === '' ? null : (JSON.parse(out).hookSpecificOutput as never)

    // The four whole-suite forms O2 names, verbatim from the brief.
    expect(decision(run('bun test'))?.permissionDecision).toBe('deny')
    expect(decision(run('bun test apps/cli/tests'))?.permissionDecision).toBe('deny')
    expect(decision(run('bunx turbo test --affected --force'))?.permissionDecision).toBe('deny')
    expect(decision(run('vitest run packages/aeg-core'))?.permissionDecision).toBe('deny')

    const denyReason = decision(run('bun test apps/cli/tests'))?.permissionDecisionReason
    expect(denyReason).toMatch(/selected-tests|test-file argument/)
    expect(denyReason).toMatch(/CI/)

    // The paired allowed shape: a real test file named on the command line.
    expect(decision(run('bun test apps/cli/tests/lib/dispatch.test.ts'))).toBeNull()

    // Security review: neither a shell comment nor a chained statement can
    // smuggle a real test-file path past the bare `bun test` that actually
    // runs — the whole-suite check judges each statement on its own, not
    // the raw command string as a whole.
    expect(decision(run('bun test # apps/cli/tests/lib/dispatch.test.ts'))?.permissionDecision).toBe('deny')
    expect(decision(run('bun test; echo apps/cli/tests/lib/dispatch.test.ts'))?.permissionDecision).toBe('deny')
  })

  it('round 3 security review, HIGH: denies a force push or a --no-verify commit/push regardless of flag order or spelling, never only the fixed-prefix shapes a settings-file pattern can express', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
    }
    const hookCommand = settings.hooks.PreToolUse[0]?.hooks[0]?.command as string
    const scriptPath = hookCommand.slice('bun "'.length, -1)

    const run = (command: string) => {
      const result = spawnBudgeted(
        [scriptPath],
        {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command, run_in_background: false } }),
          encoding: 'utf8'
        },
        'PreToolUse hook'
      )
      expect(result.status).toBe(0)
      return result.stdout.trim()
    }
    const decision = (out: string): { permissionDecision: string; permissionDecisionReason: string } | null =>
      out === '' ? null : (JSON.parse(out).hookSpecificOutput as never)

    // Every alternate spelling round 3 security review found live, none of
    // which any fixed-prefix `Bash(git push --force*)`-style settings-file
    // pattern can express: a flag after the remote/branch, git's own
    // `+refspec` force syntax with no `--force`/`-f` flag at all, and a
    // `--no-verify` after other short flags on a commit.
    expect(decision(run('git push origin --force'))?.permissionDecision).toBe('deny')
    expect(decision(run('git push origin +feature:main'))?.permissionDecision).toBe('deny')
    expect(decision(run('git push origin +HEAD:main'))?.permissionDecision).toBe('deny')
    expect(decision(run('git commit -am fix --no-verify'))?.permissionDecision).toBe('deny')
    expect(decision(run('git commit -an -m fix'))?.permissionDecision).toBe('deny')
    expect(decision(run('git push origin --force-with-lease=main'))?.permissionDecision).toBe('deny')

    // The fixed-prefix shapes still deny too — this is additive, not a
    // replacement of the settings-file deny list.
    expect(decision(run('git push --force'))?.permissionDecision).toBe('deny')
    expect(decision(run('git commit --no-verify -am x'))?.permissionDecision).toBe('deny')

    const denyReason = decision(run('git push origin --force'))?.permissionDecisionReason
    expect(denyReason).toMatch(/force-push|refspec/)

    // A genuinely ordinary push/commit is never caught by this check.
    expect(decision(run('git push origin main'))).toBeNull()
    expect(decision(run('git commit -am "a real change"'))).toBeNull()
    expect(decision(run('git commit -m "a plus sign +not-a-refspec in the message"'))).toBeNull()

    // Chained statements and shell comments cannot smuggle the forbidden
    // shape past the check either — same discipline the whole-suite check
    // (above) already holds to.
    expect(decision(run('git push origin main; git push origin +feature:main'))?.permissionDecision).toBe('deny')
    expect(decision(run('git commit -am fix # --no-verify'))).toBeNull()

    // Round 4 security review, HIGH, found live: a newline was never treated
    // as a statement separator, so a forbidden git command on its own line,
    // after an innocuous first line, ran as one un-split statement and
    // matched neither subcommand's token scan.
    expect(decision(run('echo build ok\ngit push origin --force'))?.permissionDecision).toBe('deny')
    expect(decision(run('echo build ok\ngit commit -am fix --no-verify'))?.permissionDecision).toBe('deny')
  })

  it('denies the subagent tool (Agent/Task) when its background flag is set, allows it in the foreground', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
    }
    const hookCommand = settings.hooks.PreToolUse[0]?.hooks[0]?.command as string
    const scriptPath = hookCommand.slice('bun "'.length, -1)

    for (const toolName of ['Agent', 'Task']) {
      const denied = spawnBudgeted(
        [scriptPath],
        {
          input: JSON.stringify({ tool_name: toolName, tool_input: { run_in_background: true } }),
          encoding: 'utf8'
        },
        'PreToolUse hook'
      )
      expect(denied.status).toBe(0)
      const deniedOut = JSON.parse(denied.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
      }
      expect(deniedOut.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(deniedOut.hookSpecificOutput.permissionDecisionReason).toMatch(/foreground/)

      const allowed = spawnBudgeted(
        [scriptPath],
        {
          input: JSON.stringify({ tool_name: toolName, tool_input: { run_in_background: false } }),
          encoding: 'utf8'
        },
        'PreToolUse hook'
      )
      expect(allowed.status).toBe(0)
      expect(allowed.stdout.trim()).toBe('')
    }
  })

  it('round-2 HIGH (#547, O1): denies a Bash call backgrounded by shell shape alone, not only by run_in_background:true', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
    }
    const hookCommand = settings.hooks.PreToolUse[0]?.hooks[0]?.command as string
    const scriptPath = hookCommand.slice('bun "'.length, -1)

    const run = (command: string) => {
      const result = spawnBudgeted(
        [scriptPath],
        {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command, run_in_background: false } }),
          encoding: 'utf8'
        },
        'PreToolUse hook'
      )
      expect(result.status).toBe(0)
      return result.stdout.trim()
    }
    const isDenied = (out: string) => out !== '' && JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny'

    // Each backgrounding shape, run_in_background left false throughout —
    // proving the deny fires on the command text itself, not the SDK flag.
    expect(isDenied(run('sleep 100 &'))).toBe(true)
    expect(isDenied(run('nohup sleep 100'))).toBe(true)
    expect(isDenied(run('bg; disown'))).toBe(true)
    expect(isDenied(run('setsid sleep 100'))).toBe(true)

    // A legitimate `&&` chain, and a quoted `&` inside a printed string,
    // never trigger the deny — the whole point of checking shape, not
    // merely scanning for the `&` character.
    expect(isDenied(run('npm run build && npm test'))).toBe(false)
    expect(isDenied(run('echo "background job &"'))).toBe(false)
  })

  it('never wires --settings for codex — no Claude settings flag for Codex', () => {
    for (const agent of ['codex']) {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      const argvOut = join(cwd, 'argv.out')
      writeFakeBinary(
        binDir,
        agent,
        `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
      )
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)

      const r = runDispatch(
        ['developer', '--agent', agent, '--prompt-file', promptFile],
        cwd,
        home,
        `${binDir}:${pathWithoutRealVendors()}`
      )
      expect(r.status).toBe(0)
      const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
      expect(argv.includes('--settings')).toBe(false)
    }
  })
})

describe('dispatchRole — O4 (#680): default-branch commit/push deny rule', () => {
  /**
   * A real, throwaway git checkout — self-referential `origin` remote (the
   * same trick `check-review-gate-true-head.test.ts` uses), so
   * `refs/remotes/origin/HEAD` resolves locally with no network. Omitting
   * `defaultBranch` leaves `origin/HEAD` unset entirely (the
   * "undetermined" fixture); `detach` checks out with no branch at all
   * (the "nothing to compare" fixture).
   */
  function makeGitCheckout(opts: { checkoutBranch: string; defaultBranch?: string; detach?: boolean }): string {
    const dir = tempDir('vinaya-default-branch-')
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    g(['init', '-q', '-b', opts.checkoutBranch])
    g(['config', 'user.email', 't@example.com'])
    g(['config', 'user.name', 'test'])
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'init'])
    if (opts.defaultBranch) {
      if (opts.defaultBranch !== opts.checkoutBranch) g(['branch', opts.defaultBranch])
      g(['remote', 'add', 'origin', dir])
      g(['fetch', '-q', 'origin', opts.defaultBranch])
      g(['remote', 'set-head', 'origin', opts.defaultBranch])
    }
    if (opts.detach) g(['checkout', '-q', '--detach'])
    return dir
  }

  /**
   * The `Bash|Agent|Task`-matched hook's own script — generated content
   * never depends on the cwd the dispatch that produced it happened to use
   * (it reads `process.cwd()` fresh at hook-invocation time), only the
   * WRITTEN FILE must still exist when a test runs it. Built fresh inside
   * every `it()`, never shared via `beforeAll`: the top-level `afterEach`
   * in this file wipes every `tempDir()` after EACH test, so a
   * `beforeAll`-built script (and the `tempDir()`-backed home/cwd/bin it
   * depends on) is deleted out from under every test after the first one
   * in this block, exactly the fixture-lifetime bug this comment now
   * documents having hit live.
   */
  function freshBackgroundDenyScriptPath(): string {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
    }
    const hookCommand = settings.hooks.PreToolUse[0]?.hooks[0]?.command as string
    return hookCommand.slice('bun "'.length, -1)
  }

  function run(scriptPath: string, cwd: string, command: string): string {
    const result = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command, run_in_background: false } }),
        encoding: 'utf8',
        cwd
      },
      'PreToolUse hook'
    )
    expect(result.status).toBe(0)
    return result.stdout.trim()
  }
  const decision = (out: string): { permissionDecision: string; permissionDecisionReason: string } | null =>
    out === '' ? null : (JSON.parse(out).hookSpecificOutput as never)

  it('denies a git commit/push whose cwd is a checkout on the default branch, allows the identical command from a non-default branch', () => {
    const scriptPath = freshBackgroundDenyScriptPath()
    const onDefault = makeGitCheckout({ checkoutBranch: 'main', defaultBranch: 'main' })
    expect(decision(run(scriptPath, onDefault, 'git commit -am "x"'))?.permissionDecision).toBe('deny')
    const pushDecision = decision(run(scriptPath, onDefault, 'git push origin main'))
    expect(pushDecision?.permissionDecision).toBe('deny')
    expect(pushDecision?.permissionDecisionReason).toMatch(/default branch/)

    // The identical commands, from a checkout on a NON-default branch, are
    // never caught by this rule.
    const onFeature = makeGitCheckout({ checkoutBranch: 'feature', defaultBranch: 'main' })
    expect(decision(run(scriptPath, onFeature, 'git commit -am "x"'))).toBeNull()
    expect(decision(run(scriptPath, onFeature, 'git push origin feature'))).toBeNull()

    // An ordinary read-only git command on the default branch is never
    // caught either — only `commit`/`push`.
    expect(decision(run(scriptPath, onDefault, 'git status'))).toBeNull()
  })

  it("honors a leading `cd <dir>` before the git subcommand — catches an escape into the shared main checkout even when the session's own ambient cwd is a worktree", () => {
    const scriptPath = freshBackgroundDenyScriptPath()
    const mainCheckout = makeGitCheckout({ checkoutBranch: 'main', defaultBranch: 'main' })
    const worktree = makeGitCheckout({ checkoutBranch: 'task/x', defaultBranch: 'main' })

    expect(decision(run(scriptPath, worktree, `cd ${mainCheckout} && git push origin main`))?.permissionDecision).toBe(
      'deny'
    )
    // Never denied when the command never leaves the worktree.
    expect(decision(run(scriptPath, worktree, 'git push origin task/x'))).toBeNull()
  })

  it('fails open — never a false deny — when the default branch cannot be determined, or HEAD is detached', () => {
    const scriptPath = freshBackgroundDenyScriptPath()

    // No `origin/HEAD` at all — the default branch is undetermined, the
    // SAME "fail open, never a false refusal" posture
    // `checkMainBranchRefusal`'s own doc comment states for this case.
    const noOrigin = makeGitCheckout({ checkoutBranch: 'main' })
    expect(decision(run(scriptPath, noOrigin, 'git commit -am "x"'))).toBeNull()

    // A detached HEAD has no symbolic branch to compare — never refused,
    // the same discriminator `checkMainBranchRefusal` uses.
    const detached = makeGitCheckout({ checkoutBranch: 'main', defaultBranch: 'main', detach: true })
    expect(decision(run(scriptPath, detached, 'git commit -am "x"'))).toBeNull()
  })
})

describe('buildRolePermissions — Issue #663, O1: an explicit per-role Bash allow/deny policy', () => {
  it('developer: doctrine-named version-control/forge/package/test Bash commands allowed, never a Write/Edit entry (round 2 review, BLOCKER: those never worked)', () => {
    const perms = buildRolePermissions('developer')
    for (const rule of [
      'Bash(git worktree add:*)',
      'Bash(git fetch:*)',
      'Bash(git pull:*)',
      'Bash(git commit:*)',
      'Bash(bun install:*)',
      'Bash(bun test:*)',
      'Bash(bun run:*)',
      'Bash(bun apps/cli/src/index.ts:*)'
    ]) {
      expect(perms.allow).toContain(rule)
    }
    expect(perms.allow.some((r) => r.startsWith('Write(') || r.startsWith('Edit('))).toBe(false)
  })

  it('developer: every program `bin` its reference and prompts name is admitted by both allow lists, as its source file', () => {
    const processRoot = join(import.meta.dir, '..', '..', '..')
    const texts = [
      'executing/developer/reference.md',
      'executing/developer-prompt.ts',
      'loops/dev-review/review-gate-input.ts',
      'tools/task-contract/brief-assembly.ts'
    ].map((file) => readFileSync(join(processRoot, file), 'utf8'))
    const named = new Set(texts.flatMap((text) => [...text.matchAll(/\bvinaya-[a-z][a-z-]*[a-z]\b/g)].map((m) => m[0])))
    const bins = [...named].filter((bin) => programForBin(bin) !== null)
    expect(bins.length).toBeGreaterThan(0)
    const runCommands = (
      parseYaml(readFileSync(join(processRoot, 'executing', 'developer', 'grants.yaml'), 'utf8')) as {
        capabilities: { run_commands: { allow: string[] } }
      }
    ).capabilities.run_commands.allow
    const perms = buildRolePermissions('developer')
    const missing: string[] = []
    for (const bin of bins) {
      const source = PROGRAMS.get(programForBin(bin) as string)?.source as string
      if (!runCommands.includes(`bun ${source}`))
        missing.push(`${bin}: grants.yaml run_commands lacks \`bun ${source}\``)
      if (!perms.allow.includes(`Bash(bun ${source}:*)`))
        missing.push(`${bin}: the Bash allow list lacks \`bun ${source}\``)
    }
    expect(missing).toEqual([])
    // The published form every adopter's install runs a program through.
    expect(runCommands).toContain('npx --yes -p @attalabs/vinaya@')
    expect(perms.allow).toContain('Bash(npx --yes -p @attalabs/vinaya@:*)')
  })

  it('developer: holds NO forge write — no `git push` and no `gh` allow (O4, the publishing-tools task), published only through the driver-run tools', () => {
    const perms = buildRolePermissions('developer')
    // O4: the Developer publishes, opens its PR, updates the body, refreshes
    // evidence, reads its PR and runs checks ONLY through the driver-run
    // dev-tools — it holds no forge credential, so no `git push` or `gh`
    // permission is granted, and both families are denied outright.
    expect(perms.allow).not.toContain('Bash(git push:*)')
    expect(perms.allow.some((r) => r.startsWith('Bash(gh'))).toBe(false)
    expect(perms.deny).toContain('Bash(git push:*)')
    expect(perms.deny).toContain('Bash(gh:*)')
    // The local commit the `publish_changes` tool makes from the worktree is
    // still prepared with `git commit` (no forge credential involved).
    expect(perms.allow).toContain('Bash(git commit:*)')
  })

  it('developer: destructive/verify-skipping commit shapes stay denied, narrower than the broader `git commit` allow', () => {
    const perms = buildRolePermissions('developer')
    for (const rule of [
      'Bash(git commit --no-verify*)',
      'Bash(git commit -n*)',
      'Bash(git stash*)',
      'Bash(git reset --hard*)',
      'Bash(rm -rf*)',
      'Bash(sudo*)'
    ]) {
      expect(perms.deny).toContain(rule)
    }
    // `git commit:*` stays as the broader allow whose narrower `--no-verify`
    // shape the deny list overrides — a real override, not a command never
    // allowed at all.
    expect(perms.allow).toContain('Bash(git commit:*)')
    expect(perms.deny).toContain('Bash(git commit --no-verify*)')
  })

  for (const role of ['code-reviewer', 'security'] as const) {
    it(`${role}: no allow rule at all — no git, no gh, no Write/Edit — and forge-write/package/test commands denied`, () => {
      const perms = buildRolePermissions(role)
      // The staged read-only checkout carries no `.git`, so no git command is allowed there.
      expect(perms.allow).toEqual([])
      // O2: no `gh` subcommand is granted at all — the driver stages the PR
      // body/diff/prior findings as files instead.
      expect(perms.allow.some((r) => r.startsWith('Bash(gh'))).toBe(false)
      expect(perms.allow.some((r) => r.startsWith('Write(') || r.startsWith('Edit('))).toBe(false)
      for (const rule of [
        'Bash(git push:*)',
        'Bash(git commit:*)',
        // O2: the whole `gh` family is denied, never a per-subcommand split.
        'Bash(gh:*)',
        'Bash(bun install:*)',
        'Bash(bun test:*)',
        'Bash(bun run:*)',
        // The agent-config scanner's own launcher —
        // a dispatched reviewer reads the driver-run scan, never runs one.
        'Bash(npx:*)'
      ]) {
        expect(perms.deny).toContain(rule)
      }
    })
  }

  it('a role outside this task’s three (e.g. planner) gets no rules at all — never a silent new restriction', () => {
    expect(buildRolePermissions('planner')).toEqual({ allow: [], deny: [] })
    expect(buildRolePermissions('principal')).toEqual({ allow: [], deny: [] })
    expect(buildRolePermissions('archivist')).toEqual({ allow: [], deny: [] })
    expect(buildRolePermissions('architect')).toEqual({ allow: [], deny: [] })
  })
})

/**
 * Issue #865 — the machine's own keychain, services and global settings are
 * not a dispatched role's to change. One layer only: `permissions.deny`
 * entries in the host's own `Bash(<command>:*)` grammar, which the host
 * matches against each part of a compound command itself. There is no
 * hand-written parser of shell text to test — every tokenizer tried here was
 * defeated by the next spelling found, and the containment for a wrapper
 * word, another interpreter or a script file is the worker sandbox, tracked
 * separately. What the live proof of the host's own matching is, and what it
 * does not reach, `MACHINE_STATE_DENY_RULES`'s own doc comment records.
 */
describe('buildRolePermissions — Issue #865, O1/O2/O3: machine-state commands are denied for every dispatched role', () => {
  const MACHINE_STATE_RULES = [
    'Bash(security:*)',
    'Bash(launchctl:*)',
    'Bash(defaults:*)',
    'Bash(systemsetup:*)',
    'Bash(networksetup:*)',
    'Bash(pmset:*)',
    'Bash(dscl:*)',
    'Bash(crontab:*)',
    'Bash(chsh:*)',
    'Bash(git config --global:*)',
    'Bash(git config --system:*)',
    'Bash(sudo:*)'
  ]

  for (const role of ['developer', 'code-reviewer', 'security'] as const) {
    it(`${role}: every machine-state family is a written deny entry, in the host's own rule grammar`, () => {
      const perms = buildRolePermissions(role)
      for (const rule of MACHINE_STATE_RULES) expect(perms.deny).toContain(rule)
    })
  }

  it('the whole `security` command is denied — no exemption entry survives, because Vinaya reads the Keychain in its own code, not through a dispatched agent’s shell', () => {
    for (const role of ['developer', 'code-reviewer', 'security'] as const) {
      const perms = buildRolePermissions(role)
      expect(perms.deny).toContain('Bash(security:*)')
      expect(perms.allow.some((r) => r.startsWith('Bash(security'))).toBe(false)
    }
  })

  it('every machine-state deny entry is in the host’s own `Bash(<command>:*)` form — the matching this policy relies on, never a hand-rolled pattern', () => {
    for (const rule of MACHINE_STATE_RULES) expect(rule.endsWith(':*)')).toBe(true)
  })

  it('the developer keeps repository-scoped `git config`, which Step 0 itself runs, while the global/system scopes are denied', () => {
    const perms = buildRolePermissions('developer')
    expect(perms.allow).toContain('Bash(git config:*)')
    expect(perms.deny).toContain('Bash(git config --global:*)')
    expect(perms.deny).toContain('Bash(git config --system:*)')
  })

  it('a role outside the three the loop dispatches still gets no rules at all', () => {
    expect(buildRolePermissions('planner')).toEqual({ allow: [], deny: [] })
    expect(buildRolePermissions('principal')).toEqual({ allow: [], deny: [] })
  })

  it('O3: the written policy names a version later than the one that denied no machine-state command', () => {
    expect(PERMISSION_POLICY_VERSION).toBe('v6')
    expect(PERMISSION_POLICY_VERSION).not.toBe('v2')
  })

  it('nothing else in either role’s policy regressed — every rule the previous policy carried is still there', () => {
    const developer = buildRolePermissions('developer')
    // O4: the Developer holds no forge write — `git push`/`gh` are
    // denied, not granted; it publishes only through the driver-run tools.
    // Its local-only version-control/package/test capabilities stay.
    for (const rule of ['Bash(git commit:*)', 'Bash(git pull:*)', 'Bash(bun apps/cli/src/index.ts:*)']) {
      expect(developer.allow).toContain(rule)
    }
    expect(developer.allow).not.toContain('Bash(git push:*)')
    expect(developer.allow.some((r) => r.startsWith('Bash(gh'))).toBe(false)
    for (const rule of [
      'Bash(git push:*)',
      'Bash(gh:*)',
      'Bash(git commit --no-verify*)',
      'Bash(git stash*)',
      'Bash(git reset --hard*)',
      'Bash(rm -rf*)',
      'Bash(sudo*)'
    ]) {
      expect(developer.deny).toContain(rule)
    }
    for (const role of ['code-reviewer', 'security'] as const) {
      const perms = buildRolePermissions(role)
      expect(perms.allow.some((r) => r.startsWith('Bash(git'))).toBe(false)
      for (const rule of ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(bun install:*)', 'Bash(bun test:*)']) {
        expect(perms.deny).toContain(rule)
      }
    }
  })
})

describe('buildCodexExecpolicyRules — Issue #884: a Codex dispatch carries the same machine-state floor', () => {
  // The families O1 names, and the token pattern each `Bash(<prefix>:*)` glob
  // translates to. Kept here as the test's own independent expectation — the
  // generator derives the SAME set from `buildRolePermissions().deny`, so a
  // divergence between the two is the bug this catches.
  const EXPECTED_PATTERNS: Array<[string, string[]]> = [
    ['security', ['security']],
    ['launchctl', ['launchctl']],
    ['defaults', ['defaults']],
    ['systemsetup', ['systemsetup']],
    ['networksetup', ['networksetup']],
    ['pmset', ['pmset']],
    ['dscl', ['dscl']],
    ['crontab', ['crontab']],
    ['chsh', ['chsh']],
    ['git config --global', ['git', 'config', '--global']],
    ['git config --system', ['git', 'config', '--system']],
    ['sudo', ['sudo']]
  ]

  for (const role of ['developer', 'code-reviewer', 'security'] as const) {
    it(`${role}: every machine-state family is a forbidden prefix_rule, in Codex's own grammar`, () => {
      const rules = buildCodexExecpolicyRules(role)
      expect(rules).not.toBeNull()
      for (const [, pattern] of EXPECTED_PATTERNS) {
        expect(rules).toContain(`prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = "forbidden"`)
      }
    })
  }

  it('the deny floor and the role gating are BOTH read out of buildRolePermissions — never a second list', () => {
    for (const role of ['developer', 'code-reviewer', 'security', 'planner', 'principal', 'architect'] as const) {
      const deny = buildRolePermissions(role).deny
      const machineGlobs = deny.filter((rule) => EXPECTED_PATTERNS.some(([prefix]) => rule === `Bash(${prefix}:*)`))
      const rules = buildCodexExecpolicyRules(role)
      if (machineGlobs.length === 0) {
        // A role that carries no floor on the Claude side carries none here.
        expect(rules).toBeNull()
      } else {
        // …and exactly one forbidden rule per machine-state glob that role denies.
        expect(rules).not.toBeNull()
        const forbiddenCount = (rules as string).match(/decision = "forbidden"/g)?.length ?? 0
        expect(forbiddenCount).toBe(machineGlobs.length)
      }
    }
  })

  it('a role outside the three the loop dispatches gets no .rules file at all', () => {
    expect(buildCodexExecpolicyRules('planner')).toBeNull()
    expect(buildCodexExecpolicyRules('principal')).toBeNull()
    expect(buildCodexExecpolicyRules('archivist')).toBeNull()
    expect(buildCodexExecpolicyRules('architect')).toBeNull()
  })

  it('git config is split by scope: global/system forbidden, repository scope guarded by a not_match', () => {
    const rules = buildCodexExecpolicyRules('developer') as string
    // The two scoped prefixes are forbidden…
    expect(rules).toContain('prefix_rule(pattern = ["git","config","--global"], decision = "forbidden"')
    expect(rules).toContain('prefix_rule(pattern = ["git","config","--system"], decision = "forbidden"')
    // …but a bare `["git","config"]` prefix — which would refuse Step 0's own
    // repository-scoped `git config` — is never emitted, and the not_match
    // pins that split into the file's own Codex load-time validation.
    expect(rules).not.toContain('prefix_rule(pattern = ["git","config"],')
    expect(rules).toContain('not_match = [["git","config","x"]]')
  })

  it('O3: the .rules file carries the same version string the Claude Code policy carries', () => {
    const rules = buildCodexExecpolicyRules('developer') as string
    expect(rules).toContain(`permission policy ${PERMISSION_POLICY_VERSION}`)
  })

  it('the file records that it is generated for the run, never written into the operator’s ~/.codex', () => {
    const rules = buildCodexExecpolicyRules('developer') as string
    expect(rules).toContain('do not edit by hand')
    expect(rules).toContain('~/.codex')
  })
})

describe('buildWriteAccessScope — Issue #663, O1 round 2 fix: the real Write/Edit grant', () => {
  it('developer: a directory scope, realpath-resolved', () => {
    const dir = tempDir('vinaya-write-scope-')
    const scope = buildWriteAccessScope('developer', dir, [])
    expect(scope).toEqual({
      kind: 'directory',
      allowedDir: realpathSync(dir),
      extraFiles: [],
      protectedSubpaths: [],
      openedSubpaths: []
    })
  })

  it('developer: extraFiles (O3, task-files-v1 2, #649) carries the exact files the driver names, realpath-resolved, alongside the worktree directory grant', () => {
    const dir = tempDir('vinaya-write-scope-')
    const devDir = tempDir('vinaya-write-scope-dev-')
    const confidence = join(devDir, 'granted-one.txt')
    const roundResponse = join(devDir, 'granted-two.txt')
    const scope = buildWriteAccessScope('developer', dir, [confidence, roundResponse])
    // Resolved through the parent, exactly as `writeAccessHookScript` resolves
    // the path it compares against: on a host whose temp root is a symlink
    // (macOS `/var` → `/private/var`), a raw expectation here fails while the
    // grant is correct — the sibling symlinked-ancestor test below asserts the
    // same resolution deliberately.
    const realDevDir = realpathSync(devDir)
    expect(scope).toEqual({
      kind: 'directory',
      allowedDir: realpathSync(dir),
      extraFiles: [join(realDevDir, 'granted-one.txt'), join(realDevDir, 'granted-two.txt')],
      protectedSubpaths: [],
      openedSubpaths: []
    })
  })

  it('developer: extraFiles resolves through a symlinked ancestor even though the file itself does not exist yet (round 2 review, MAJOR) — matching writeAccessHookScript’s own live comparison', () => {
    const dir = tempDir('vinaya-write-scope-')
    const realParent = tempDir('vinaya-write-scope-realparent-')
    const linkContainer = tempDir('vinaya-write-scope-link-')
    const symlinkedRoot = join(linkContainer, 'runs')
    symlinkSync(realParent, symlinkedRoot)
    const devDir = join(symlinkedRoot, 'rounds', '2', 'developer')
    mkdirSync(devDir, { recursive: true })
    // Never created — every developerFiles entry is genuinely absent at
    // scope-build time (the Developer has not written it yet this round).
    const confidence = join(devDir, 'granted-one.txt')

    const scope = buildWriteAccessScope('developer', dir, [confidence])
    expect(scope).not.toBeNull()
    if (scope === null) return
    expect(scope.kind).toBe('directory')
    const resolved = (scope as { extraFiles: string[] }).extraFiles[0]

    // Never the raw, symlinked-through path `real()` alone would have fallen
    // back to (the pre-fix behavior: `realpathSync` on the whole,
    // not-yet-existing path throws, and the catch returned it unresolved).
    expect(resolved).not.toBe(confidence)
    // The SAME canonical path `writeAccessHookScript`'s own live comparison
    // computes for an identical Write call — `realpathSync(dirname(filePath))`
    // joined with the basename — so a real dispatch's grant and its own
    // hook's check agree.
    expect(resolved).toBe(join(realpathSync(devDir), 'granted-one.txt'))
  })

  it('a role other than developer never gets developerFiles applied', () => {
    const scope = buildWriteAccessScope('code-reviewer', '/unused', ['/some/absolute/path'])
    expect(scope).toEqual({ kind: 'exact-files', paths: [] })
  })

  for (const role of ['code-reviewer', 'security'] as const) {
    it(`${role}: no file at all — a reviewer returns its review as structured output, so every write is denied`, () => {
      expect(buildWriteAccessScope(role, '/unused')).toEqual({ kind: 'exact-files', paths: [] })
    })
  }

  it('a role outside the three named — null', () => {
    expect(buildWriteAccessScope('planner', tempDir('vinaya-write-scope-'), [])).toBeNull()
  })

  it('a directory that does not exist yet degrades to its own raw form rather than throwing', () => {
    const scope = buildWriteAccessScope('developer', '/tmp/does-not-exist-vinaya-663', [])
    expect(scope).toEqual({
      kind: 'directory',
      allowedDir: '/tmp/does-not-exist-vinaya-663',
      extraFiles: [],
      protectedSubpaths: [],
      openedSubpaths: []
    })
  })

  it('developer: protectedSubpaths (O3) carries the realpath-resolved agent-config paths the caller named', () => {
    const dir = tempDir('vinaya-write-scope-protected-')
    const protectedPath = join(dir, '.claude')
    const scope = buildWriteAccessScope('developer', dir, [], [protectedPath])
    expect(scope).toEqual({
      kind: 'directory',
      allowedDir: realpathSync(dir),
      extraFiles: [],
      protectedSubpaths: [join(realpathSync(dir), '.claude')],
      openedSubpaths: []
    })
  })

  it('developer: openedSubpaths carries the realpath-resolved configuration directories the Surface opened', () => {
    const dir = tempDir('vinaya-write-scope-opened-')
    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true })
    const scope = buildWriteAccessScope('developer', dir, [], [join(dir, '.claude')], [join(dir, '.claude', 'rules')])
    expect(scope).toEqual({
      kind: 'directory',
      allowedDir: realpathSync(dir),
      extraFiles: [],
      protectedSubpaths: [join(realpathSync(dir), '.claude')],
      openedSubpaths: [join(realpathSync(dir), '.claude', 'rules')]
    })
  })
})

// O3: the write-access.mjs hook itself DENIES an
// agent's own configuration path inside the worktree when the caller names
// it `protectedSubpaths`, and ALLOWS it (the ordinary in-worktree case) when
// the caller does not — real `node`, real stdin, the same harness the O4
// "outside worktree DENIES" test above already uses, since this is the SAME
// hook script, not a second mechanism.
describe('writeAccessHookScript — O3 agent-configuration protectedSubpaths', () => {
  type HookDecision = { permissionDecision: string; permissionDecisionReason?: string }

  function runHook(scriptDir: string, runId: string, filePath: string): HookDecision {
    const scriptPath = join(scriptDir, 'write-access.mjs')
    writeFileSync(scriptPath, writeAccessHookScript(scriptDir), { mode: 0o600 })
    const result = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'write-access hook'
    )
    expect(result.status).toBe(0)
    return (JSON.parse(result.stdout) as { hookSpecificOutput: HookDecision }).hookSpecificOutput
  }

  it('denies a write to .claude/settings.json inside the worktree when it is a named protectedSubpath', () => {
    const scriptDir = tempDir('vinaya-write-access-protected-')
    const worktree = tempDir('vinaya-write-access-protected-wt-')
    const runId = randomUUID()
    const scope = buildWriteAccessScope('developer', worktree, [], agentConfigProtectedSubpaths(worktree, 'claude'))
    writeFileSync(join(scriptDir, `write-access-${runId}.json`), JSON.stringify(scope))

    const decision = runHook(scriptDir, runId, join(realpathSync(worktree), '.claude', 'settings.json'))
    expect(decision.permissionDecision).toBe('deny')
    expect(decision.permissionDecisionReason).toMatch(/configuration/)

    // An ordinary file elsewhere in the same worktree stays allowed —
    // protection is scoped to exactly the named agent-config path.
    const ordinary = runHook(scriptDir, runId, join(realpathSync(worktree), 'src', 'index.ts'))
    expect(ordinary.permissionDecision).toBe('allow')
  })

  it('allows a write inside an opened .claude/rules while .claude/settings.json, .claude/hooks and .mcp.json stay denied', () => {
    const scriptDir = tempDir('vinaya-write-access-opened-')
    const worktree = tempDir('vinaya-write-access-opened-wt-')
    const realWt = realpathSync(worktree)
    mkdirSync(join(worktree, '.claude', 'rules'), { recursive: true })
    mkdirSync(join(worktree, '.claude', 'hooks'), { recursive: true })
    const runId = randomUUID()
    const opened = resolveOpenedAgentConfigPaths(
      worktree,
      surfaceOpenedAgentConfigPaths({ in: ['.claude/rules'], out: [] }, 'claude')
    )
    const scope = buildWriteAccessScope(
      'developer',
      worktree,
      [],
      agentConfigProtectedSubpaths(worktree, 'claude'),
      opened
    )
    writeFileSync(join(scriptDir, `write-access-${runId}.json`), JSON.stringify(scope))

    expect(runHook(scriptDir, runId, join(realWt, '.claude', 'rules', 'style.md')).permissionDecision).toBe('allow')
    for (const denied of [
      join(realWt, '.claude', 'settings.json'),
      join(realWt, '.claude', 'hooks', 'pre.sh'),
      join(realWt, '.claude', 'rules-other.md'),
      join(realWt, '.mcp.json')
    ]) {
      const decision = runHook(scriptDir, runId, denied)
      expect(decision.permissionDecision).toBe('deny')
      expect(decision.permissionDecisionReason).toMatch(/configuration/)
    }
  })

  it('a Surface naming .claude opens all of .claude for the hook but never .mcp.json', () => {
    const scriptDir = tempDir('vinaya-write-access-whole-')
    const worktree = tempDir('vinaya-write-access-whole-wt-')
    const realWt = realpathSync(worktree)
    mkdirSync(join(worktree, '.claude'), { recursive: true })
    const runId = randomUUID()
    const opened = resolveOpenedAgentConfigPaths(
      worktree,
      surfaceOpenedAgentConfigPaths({ in: ['.claude'], out: [] }, 'claude')
    )
    const scope = buildWriteAccessScope(
      'developer',
      worktree,
      [],
      agentConfigProtectedSubpaths(worktree, 'claude'),
      opened
    )
    writeFileSync(join(scriptDir, `write-access-${runId}.json`), JSON.stringify(scope))

    expect(runHook(scriptDir, runId, join(realWt, '.claude', 'settings.json')).permissionDecision).toBe('allow')
    expect(runHook(scriptDir, runId, join(realWt, '.mcp.json')).permissionDecision).toBe('deny')
  })

  it('also denies a write to the bare .mcp.json file (Claude)', () => {
    const scriptDir = tempDir('vinaya-write-access-mcpjson-')
    const worktree = tempDir('vinaya-write-access-mcpjson-wt-')
    const runId = randomUUID()
    const scope = buildWriteAccessScope('developer', worktree, [], agentConfigProtectedSubpaths(worktree, 'claude'))
    writeFileSync(join(scriptDir, `write-access-${runId}.json`), JSON.stringify(scope))

    expect(runHook(scriptDir, runId, join(realpathSync(worktree), '.mcp.json')).permissionDecision).toBe('deny')
  })

  it("denies a write to Codex's own .codex/ and .agents/ paths the same way", () => {
    const scriptDir = tempDir('vinaya-write-access-codex-')
    const worktree = tempDir('vinaya-write-access-codex-wt-')
    const runId = randomUUID()
    const scope = buildWriteAccessScope('developer', worktree, [], agentConfigProtectedSubpaths(worktree, 'codex'))
    writeFileSync(join(scriptDir, `write-access-${runId}.json`), JSON.stringify(scope))

    expect(runHook(scriptDir, runId, join(realpathSync(worktree), '.codex', 'config.toml')).permissionDecision).toBe(
      'deny'
    )
    expect(
      runHook(scriptDir, runId, join(realpathSync(worktree), '.agents', 'skills', 'x', 'SKILL.md')).permissionDecision
    ).toBe('deny')
  })
})

describe('writeDispatchSettings — Issue #663, O1/O3: the permission policy is wired into the real settings file', () => {
  it('a developer dispatch writes settings.permissions matching buildRolePermissions for its own cwd', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[]; deny: string[] }
    }

    expect(settings.permissions).toEqual(buildRolePermissions('developer'))
  })

  it('a developer dispatch also wires a Write|Edit hook granting real access inside its own cwd, and DENIES outside it (O4, #680)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    }
    const writeEntry = settings.hooks.PreToolUse.find((h) => h.matcher === 'Write|Edit')
    expect(writeEntry).toBeDefined()
    const hookCommand = writeEntry?.hooks[0]?.command as string
    expect(hookCommand).toMatch(/^bun "/)
    const scriptPath = hookCommand.slice('bun "'.length, -1)

    // The run_id this dispatch actually used — read back from the scope
    // file's own name (the one file `writeDispatchSettings` wrote for this
    // run), rather than assumed, since both the script and its scope file
    // are keyed by it.
    const scopeFiles = readdirSync(dirname(scriptPath)).filter((f) => f.startsWith('write-access-'))
    expect(scopeFiles).toHaveLength(1)
    const runId = (scopeFiles[0] as string).slice('write-access-'.length, -'.json'.length)

    const insideCwd = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(cwd, 'new-file.txt') } }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'write-access hook'
    )
    expect(insideCwd.status).toBe(0)
    const insideOut = JSON.parse(insideCwd.stdout) as {
      hookSpecificOutput: { permissionDecision: string }
    }
    expect(insideOut.hookSpecificOutput.permissionDecision).toBe('allow')

    // O4 (`#680`): a `directory`-scoped path outside the written scope now
    // DENIES — before this task it fell through silently (the assertion this
    // test used to make), which is the exact gap the origin incident (a
    // developer session writing in the shared main checkout instead of its
    // own worktree) exploited.
    const outsideCwd = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/etc/vinaya-should-never-write-here' } }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'write-access hook'
    )
    expect(outsideCwd.status).toBe(0)
    const outsideOut = JSON.parse(outsideCwd.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
    }
    expect(outsideOut.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(outsideOut.hookSpecificOutput.permissionDecisionReason).toMatch(/worktree/)
  })

  it("a developer dispatch DENIES both a Write and an Edit to a path outside BOTH the real home and the real temp root (round 2 ruling, F1) — the sandbox's own disclosed gap, closed here by this same Write|Edit hook", () => {
    // `isolation.md` §4a's own disclosed gap: "a path outside BOTH the real
    // home and the real temp root (`/etc`, `/opt`, a second mount) is covered
    // by neither `denyRead` nor `permissionsDeny`". The Write/Edit hook under
    // test here is scoped to the worktree directly — never relative to home
    // or temp — so it denies a path like this regardless, closing the gap for
    // Write/Edit even though the sandbox's own read-deny rows do not reach it.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    }
    const writeEntry = settings.hooks.PreToolUse.find((h) => h.matcher === 'Write|Edit')
    expect(writeEntry).toBeDefined()
    const hookCommand = writeEntry?.hooks[0]?.command as string
    const scriptPath = hookCommand.slice('bun "'.length, -1)
    const scopeFiles = readdirSync(dirname(scriptPath)).filter((f) => f.startsWith('write-access-'))
    expect(scopeFiles).toHaveLength(1)
    const runId = (scopeFiles[0] as string).slice('write-access-'.length, -'.json'.length)

    // Neither under the real `os.homedir()` nor under the real `os.tmpdir()`
    // (where every fixture `home`/`cwd` in this file lives) — its immediate
    // parent does not exist either, exercising the hook's own
    // `realpathSync` failure fallback (raw, unresolved comparison) the same
    // way a genuinely out-of-scope path would on a live host.
    const outsidePath = '/opt/vinaya-should-never-write-here/x'
    expect(outsidePath.startsWith(homedir())).toBe(false)
    expect(outsidePath.startsWith(tmpdir())).toBe(false)

    for (const toolName of ['Write', 'Edit']) {
      const result = spawnBudgeted(
        [scriptPath],
        {
          input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: outsidePath } }),
          encoding: 'utf8',
          env: { ...process.env, VINAYA_RUN_ID: runId }
        },
        'write-access hook'
      )
      expect(result.status).toBe(0)
      const out = JSON.parse(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
      }
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/worktree/)
    }
  })

  for (const role of ['code-reviewer', 'security'] as const) {
    it(`a ${role} dispatch's exact-files scope DENIES every Write and Edit — a reviewer writes no file, not even a former result file`, () => {
      // A reviewer returns its review as native structured output, so its
      // `exact-files` scope names no path at all: every Write/Edit is denied
      // by this hook's own written restriction, never left to the host's own
      // default classifier. Called through `dispatchRole` directly, the way
      // the loop dispatches a reviewer.
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      const reviewWorkDir = tempDir('vinaya-dispatch-reviewwork-')
      const argvOut = join(cwd, 'argv.out')
      writeFakeBinary(
        binDir,
        'claude',
        `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
      )
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)

      const dispatchLib = join(
        CLI_ROOT,
        '..',
        '..',
        'harness',
        'processes',
        'vinaya-strict',
        'loops',
        'dev-review',
        'dispatch',
        'dispatch.ts'
      )
      const script = join(cwd, `${role}-exact-files-dispatch.ts`)
      writeFileSync(
        script,
        [
          `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
          'const opts = {',
          `  promptFile: ${JSON.stringify(promptFile)},`,
          `  cwd: ${JSON.stringify(cwd)}`,
          '}',
          `await dispatchRole(${JSON.stringify(role)}, 'claude', 'p', opts)`
        ].join('\n')
      )
      const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${pathWithoutRealVendors()}`
      })
      runScriptWithBudget(script, cwd, spawnEnv)

      const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
      const settingsIdx = argv.indexOf('--settings')
      const settingsPath = argv[settingsIdx + 1] as string
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
      }
      const writeEntry = settings.hooks.PreToolUse.find((h) => h.matcher === 'Write|Edit')
      expect(writeEntry).toBeDefined()
      const hookCommand = writeEntry?.hooks[0]?.command as string
      const scriptPath = hookCommand.slice('bun "'.length, -1)
      const scopeFiles = readdirSync(dirname(scriptPath)).filter((f) => f.startsWith('write-access-'))
      expect(scopeFiles).toHaveLength(1)
      const runId = (scopeFiles[0] as string).slice('write-access-'.length, -'.json'.length)

      // A former result file, a file in the reviewer's own scratch directory,
      // and a path entirely outside both the real home and the real temp
      // root — all DENIED, for both `Write` and `Edit`.
      const formerResultPath = join(realpathSync(reviewWorkDir), 'findings.txt')
      const scratchPath = join(realpathSync(cwd), 'notes.txt')
      const outsidePath = '/opt/vinaya-should-never-write-here/x'
      for (const toolName of ['Write', 'Edit']) {
        for (const deniedPath of [formerResultPath, scratchPath, outsidePath]) {
          const result = spawnBudgeted(
            [scriptPath],
            {
              input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: deniedPath } }),
              encoding: 'utf8',
              env: { ...process.env, VINAYA_RUN_ID: runId }
            },
            'write-access hook'
          )
          expect(result.status).toBe(0)
          const out = JSON.parse(result.stdout) as {
            hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
          }
          expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
          expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/structured result/)
        }
      }
    })
  }

  it('a developer dispatch carrying developerFiles (O3, task-files-v1 2, #649) ALLOWS a write to exactly those two files outside its worktree, and still DENIES an unrelated outside path', () => {
    // `developerFiles` has no CLI flag (same reasoning `extraWritableDirs`'s
    // own comment gives — only `dev-review-loop.ts`'s internal call site
    // ever supplies one), so this calls `dispatchRole` directly rather than
    // through the `vinaya dispatch` CLI, the same pattern the "two
    // dispatches in the same process" describe block above uses.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const devFilesDir = tempDir('vinaya-dispatch-devfiles-')
    const confidencePath = join(devFilesDir, 'granted-one.txt')
    const roundResponsePath = join(devFilesDir, 'granted-two.txt')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'developer-files-dispatch.ts')
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        'const opts = {',
        `  promptFile: ${JSON.stringify(promptFile)},`,
        `  cwd: ${JSON.stringify(cwd)},`,
        `  developerFiles: [${JSON.stringify(confidencePath)}, ${JSON.stringify(roundResponsePath)}]`,
        '}',
        `await dispatchRole('developer', 'claude', 'p', opts)`
      ].join('\n')
    )
    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    }
    const writeEntry = settings.hooks.PreToolUse.find((h) => h.matcher === 'Write|Edit')
    expect(writeEntry).toBeDefined()
    const hookCommand = writeEntry?.hooks[0]?.command as string
    const scriptPath = hookCommand.slice('bun "'.length, -1)
    const scopeFiles = readdirSync(dirname(scriptPath)).filter((f) => f.startsWith('write-access-'))
    expect(scopeFiles).toHaveLength(1)
    const runId = (scopeFiles[0] as string).slice('write-access-'.length, -'.json'.length)

    for (const grantedPath of [confidencePath, roundResponsePath]) {
      const r = spawnBudgeted(
        [scriptPath],
        {
          input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: grantedPath } }),
          encoding: 'utf8',
          env: { ...process.env, VINAYA_RUN_ID: runId }
        },
        'write-access hook'
      )
      expect(r.status).toBe(0)
      const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
    }

    // A third, unrelated file outside the worktree — never granted — is
    // still denied: `developerFiles` is an exact-file allowlist, never a
    // directory grant on `devFilesDir`.
    const unrelatedPath = join(devFilesDir, 'not-granted.txt')
    const denied = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: unrelatedPath } }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'write-access hook'
    )
    expect(denied.status).toBe(0)
    const deniedOut = JSON.parse(denied.stdout) as { hookSpecificOutput: { permissionDecision: string } }
    expect(deniedOut.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('a developer dispatch grants the configuration directories its Surface opened to both agents: Claude through openedSubpaths, Codex as an extra writable root', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const claudeArgv = join(home, 'claude-argv.out')
    const codexArgv = join(home, 'codex-argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${claudeArgv}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    writeFakeBinary(
      binDir,
      'codex',
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${codexArgv}"\ncat > /dev/null\nprintf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'\n`
    )
    const promptFile = join(home, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(home, 'opened-config-dispatch.ts')
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        `const base = { promptFile: ${JSON.stringify(promptFile)}, cwd: ${JSON.stringify(cwd)} }`,
        `await dispatchRole('developer', 'claude', 'p', { ...base, agentConfigOpened: [{ path: '.claude/rules', createIfMissing: true }] })`,
        `await dispatchRole('developer', 'codex', 'p', { ...base, agentConfigOpened: [{ path: '.agents/skills', createIfMissing: true }] })`
      ].join('\n')
    )
    runScriptWithBudget(
      script,
      cwd,
      stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
    )
    const realCwd = realpathSync(cwd)

    // Both missing `/**` directories were created by the driver before launch.
    expect(statSync(join(cwd, '.claude', 'rules')).isDirectory()).toBe(true)
    expect(statSync(join(cwd, '.agents', 'skills')).isDirectory()).toBe(true)

    const argv = readFileSync(claudeArgv, 'utf8').trim().split('\n')
    const settingsPath = argv[argv.indexOf('--settings') + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    }
    const hookCommand = settings.hooks.PreToolUse.find((h) => h.matcher === 'Write|Edit')?.hooks[0]?.command as string
    const hookDir = dirname(hookCommand.slice('bun "'.length, -1))
    const scopeFile = readdirSync(hookDir).find((f) => f.startsWith('write-access-')) as string
    const scope = JSON.parse(readFileSync(join(hookDir, scopeFile), 'utf8')) as {
      protectedSubpaths: string[]
      openedSubpaths: string[]
    }
    expect(scope.openedSubpaths).toEqual([join(realCwd, '.claude', 'rules')])
    expect(scope.protectedSubpaths).toEqual([join(realCwd, '.claude'), join(realCwd, '.mcp.json')])

    const codexArgs = readArgv(codexArgv)
    const addDirs = codexArgs.flatMap((a, i) => (a === '--add-dir' ? [codexArgs[i + 1]] : []))
    expect(addDirs).toContain(join(realCwd, '.agents', 'skills'))
    expect(addDirs).not.toContain(join(realCwd, '.agents'))
    expect(addDirs).not.toContain(join(realCwd, '.codex'))
  })

  it('developerFiles behind a symlinked ancestor still ALLOWS end to end — the grant and the live hook check agree (round 2 review, MAJOR)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const realDevFilesDir = tempDir('vinaya-dispatch-devfiles-real-')
    const linkContainer = tempDir('vinaya-dispatch-devfiles-link-')
    const linkedDevFilesDir = join(linkContainer, 'developer')
    symlinkSync(realDevFilesDir, linkedDevFilesDir)
    // Named through the SYMLINK, exactly as `dev-review-loop.ts`'s
    // `runPath` would name a granted file if `runtimeDir` itself traversed one
    // (`/var` → `/private/var`, this reference's own documented example) —
    // never created, matching the real "not written yet this round" case.
    const confidencePath = join(linkedDevFilesDir, 'granted-one.txt')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'developer-files-symlink-dispatch.ts')
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        'const opts = {',
        `  promptFile: ${JSON.stringify(promptFile)},`,
        `  cwd: ${JSON.stringify(cwd)},`,
        `  developerFiles: [${JSON.stringify(confidencePath)}]`,
        '}',
        `await dispatchRole('developer', 'claude', 'p', opts)`
      ].join('\n')
    )
    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    }
    const writeEntry = settings.hooks.PreToolUse.find((h) => h.matcher === 'Write|Edit')
    const hookCommand = writeEntry?.hooks[0]?.command as string
    const scriptPath = hookCommand.slice('bun "'.length, -1)
    const scopeFiles = readdirSync(dirname(scriptPath)).filter((f) => f.startsWith('write-access-'))
    const runId = (scopeFiles[0] as string).slice('write-access-'.length, -'.json'.length)

    // Claude Code itself would report `tool_input.file_path` as the caller
    // spelled it — through the symlink, never pre-resolved — since it never
    // saw the real target either.
    const r = spawnBudgeted(
      [scriptPath],
      {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: confidencePath } }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'write-access hook'
    )
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
  })

  it('a code-reviewer dispatch writes the read-only policy, never the developer one', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['code-reviewer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsIdx = argv.indexOf('--settings')
    const settingsPath = argv[settingsIdx + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[]; deny: string[] }
      hooks: { PreToolUse: Array<{ matcher: string }> }
    }
    expect(settings.permissions).toEqual(buildRolePermissions('code-reviewer'))
    expect(settings.permissions.allow).not.toContain('Bash(git commit:*)')
    // A reviewer writes no file: its Write|Edit hook is wired with a scope
    // that grants no path at all — never a blanket grant, never no hook.
    expect(settings.hooks.PreToolUse.some((h) => h.matcher === 'Write|Edit')).toBe(true)
    const scopeFile = readdirSync(dirname(settingsPath)).find((f) => f.startsWith('write-access-'))
    expect(JSON.parse(readFileSync(join(dirname(settingsPath), scopeFile as string), 'utf8'))).toEqual({
      kind: 'exact-files',
      paths: []
    })
  })

  it('round 2 security review, CRITICAL fix: developer and code-reviewer dispatched for the same task scope get DIFFERENT settings files, never a shared path to race on', () => {
    const home = tempDir('vinaya-dispatch-home-')

    const dispatchOne = (role: string): string => {
      const cwd = tempDir(`vinaya-dispatch-cwd-${role}-`)
      const binDir = tempDir(`vinaya-dispatch-bin-${role}-`)
      const argvOut = join(cwd, 'argv.out')
      writeFakeBinary(
        binDir,
        'claude',
        `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
      )
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)
      const r = runDispatch(
        [role, '--agent', 'claude', '--prompt-file', promptFile],
        cwd,
        home,
        `${binDir}:${pathWithoutRealVendors()}`
      )
      expect(r.status).toBe(0)
      const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
      const settingsIdx = argv.indexOf('--settings')
      return argv[settingsIdx + 1] as string
    }

    const devSettingsPath = dispatchOne('developer')
    const revSettingsPath = dispatchOne('code-reviewer')

    expect(devSettingsPath).not.toBe(revSettingsPath)
    expect(dirname(devSettingsPath)).not.toBe(dirname(revSettingsPath))
    const devSettings = JSON.parse(readFileSync(devSettingsPath, 'utf8')) as { permissions: { allow: string[] } }
    const revSettings = JSON.parse(readFileSync(revSettingsPath, 'utf8')) as { permissions: { allow: string[] } }
    expect(devSettings.permissions.allow).toContain('Bash(git commit:*)')
    expect(revSettings.permissions.allow).not.toContain('Bash(git commit:*)')
  })

  /**
   * A `--agent codex` dispatch of a role that carries no machine-state floor —
   * runs with no permission policy, and says so in its first lifecycle line,
   * so a run log is never indistinguishable from a protected one. A Codex
   * dispatch of a floor-carrying role is the separate case just below: it now
   * DOES carry the machine-state deny list, through Codex's own execpolicy.
   */
  for (const [agent, role] of [['codex', 'planner']] as const) {
    it(`an agent that carries no permission policy says so in its own first lifecycle line (${agent}/${role})`, () => {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      writeFakeBinary(binDir, agent, `#!/bin/sh\nwhile read -r line; do :; done\ncat > /dev/null\necho '{}'\nexit 0\n`)
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)
      const roleLogPath = join(cwd, 'role.log')

      const r = runDispatch(
        [role, '--agent', agent, '--prompt-file', promptFile, '--role-log-path', roleLogPath],
        cwd,
        home,
        `${binDir}:${pathWithoutRealVendors()}`
      )
      expect(r.status).toBe(0)

      const lines = readFileSync(roleLogPath, 'utf8').trim().split('\n')
      const policyLine = lines.find((l) => l.includes('permission policy'))
      expect(policyLine).toBeDefined()
      expect(policyLine).toContain('NO permission policy')
      expect(policyLine).toMatch(/machine-state commands .* are NOT denied for this agent/)
      // Never the claim a protected run makes.
      expect(policyLine).not.toContain(`permission policy ${PERMISSION_POLICY_VERSION} written to`)
    })
  }

  /**
   * O1/O3 honesty (round 2 review, Security MEDIUM F2): when neither path can
   * carry the floor — no worker boundary (attended here, and non-Darwin) AND no
   * operator `~/.codex/auth.json` to re-home from (this fresh HOME has none, the
   * keychain-only edge `stageCodexPolicyHome` returns null for) — the lifecycle
   * line must say the policy was generated but NOT applied, naming the version,
   * never claiming a protected run. (The staged cases are the boundary path and
   * the re-homable-login sibling test just below.)
   */
  it('a codex dispatch that can stage no run-scoped CODEX_HOME reports its execpolicy generated but NOT staged', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'codex', `#!/bin/sh\nwhile read -r line; do :; done\ncat > /dev/null\necho '{}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const roleLogPath = join(cwd, 'role.log')

    const r = runDispatch(
      ['developer', '--agent', 'codex', '--prompt-file', promptFile, '--role-log-path', roleLogPath],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const lines = readFileSync(roleLogPath, 'utf8').trim().split('\n')
    const policyLine = lines.find((l) => l.includes('execpolicy'))
    expect(policyLine).toBeDefined()
    // Names the version it generated, but is explicit that it is NOT staged /
    // NOT denied this run — never the "denied via ... staged into" claim.
    expect(policyLine).toContain(PERMISSION_POLICY_VERSION)
    expect(policyLine).toContain('NOT staged')
    expect(policyLine).toContain('NOT denied')
    expect(policyLine).not.toContain('denied via Codex execpolicy staged')
  })

  /**
   * O1 (round 2 review, Reviewer MAJOR / Security HIGH F1): with no worker
   * boundary but an operator `~/.codex/auth.json` to re-home from, the floor
   * IS staged on this every-run path — the Codex child receives a run-scoped
   * `CODEX_HOME` whose `rules/` carries the machine-state deny floor, with the
   * operator's auth symlinked through — so a `--agent codex` role is refused
   * the same commands a Claude role is, the way Claude's `--settings` applies
   * on every run.
   */
  it('a codex dispatch with no boundary but a re-homable ~/.codex login stages the floor into a run-scoped CODEX_HOME', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    // The operator is logged in via auth.json — the re-homable case.
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{"access_token":"operator-token"}}')
    const codexHomeOut = join(cwd, 'codex-home.txt')
    const ghTelemetryOut = join(cwd, 'gh-telemetry.txt')
    writeFakeBinary(
      binDir,
      'codex',
      `#!/bin/sh\nprintf '%s' "$CODEX_HOME" > "${codexHomeOut}"\nprintf '%s' "$GH_TELEMETRY" > "${ghTelemetryOut}"\nwhile read -r line; do :; done\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const roleLogPath = join(cwd, 'role.log')

    const r = runDispatch(
      ['developer', '--agent', 'codex', '--prompt-file', promptFile, '--role-log-path', roleLogPath],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    // The lifecycle line claims the floor — because it is genuinely staged.
    const policyLine = readFileSync(roleLogPath, 'utf8')
      .trim()
      .split('\n')
      .find((l) => l.includes('execpolicy'))
    expect(policyLine).toContain('denied via Codex execpolicy staged')

    // The child actually received a run-scoped CODEX_HOME whose rules dir
    // carries the machine-state floor, with the operator's auth symlinked in.
    const codexHome = readFileSync(codexHomeOut, 'utf8').trim()
    expect(codexHome).not.toBe('')
    expect(readFileSync(ghTelemetryOut, 'utf8')).toBe('0')
    expect(readFileSync(join(codexHome, 'rules', 'vinaya-machine-state.rules'), 'utf8')).toContain(
      'prefix_rule(pattern = ["sudo"], decision = "forbidden"'
    )
    expect(readFileSync(join(codexHome, 'auth.json'), 'utf8')).toContain('operator-token')
  })

  it("O3: the role's first lifecycle line names the permission policy version it wrote", () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\nwhile read -r line; do :; done\ncat > /dev/null\necho '{}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const roleLogPath = join(cwd, 'role.log')

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--role-log-path', roleLogPath],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const lines = readFileSync(roleLogPath, 'utf8').trim().split('\n')
    const policyLine = lines.find((l) => l.includes('permission policy'))
    expect(policyLine).toBeDefined()
    expect(policyLine).toContain(`permission policy ${PERMISSION_POLICY_VERSION} written to`)
    // The first line this role's dispatch writes to its own log — every
    // OTHER lifecycle line in a normal claude dispatch (settings-write
    // failure, boundary refusal) sits behind an early return this fixture
    // never reaches.
    expect(lines[0]).toBe(policyLine)
  })
})

describe('codexSpawnEnvExtras — round 6 security review, CRITICAL (Issue #676)', () => {
  it('a staged subscription session (codexHomeDir set) carries CODEX_HOME but never CODEX_ACCESS_TOKEN — live-verified the env var breaks bearer auth once a real auth.json exists', () => {
    const extras = codexSpawnEnvExtras('codex', '/tmp/scratch/codex-home')
    expect(extras.attribution).toEqual({ CODEX_HOME: '/tmp/scratch/codex-home' })
    expect(extras.attribution).not.toHaveProperty('CODEX_ACCESS_TOKEN')
  })

  it('O1: the staged CODEX_HOME is the whole environment route — there is no credential-key passthrough left to return', () => {
    expect(Object.keys(codexSpawnEnvExtras('codex', '/tmp/scratch/codex-home'))).toEqual(['attribution'])
  })

  it('no staged session (codexHomeDir null) sets no CODEX_HOME at all — and no key replaces it, since no agent authenticates with an API key', () => {
    expect(codexSpawnEnvExtras('codex', null).attribution).toEqual({})
  })

  it('a non-codex vendor never gets CODEX_HOME even if codexHomeDir were somehow non-null', () => {
    expect(codexSpawnEnvExtras('claude', '/tmp/scratch/codex-home').attribution).toEqual({})
  })
})

// Round 5 Principal ruling: `bun install` failed under Codex's own sandbox
// with "bun is unable to write files to tempdir: EPERM" — this function is
// now the ONE shared place both a real Codex dispatch (`dispatchRole`) and
// the sandbox-conformance suite's own `codexSession()` get TMPDIR/TMP/TEMP
// from, pointed at the same writable scratch directory, rather than each
// building its own (possibly-drifting) copy.
describe('codexSpawnEnvExtras — TMPDIR/TMP/TEMP pointed at the writable scratch directory (round 5 Principal ruling)', () => {
  it('a codex dispatch with a scratch directory carries TMPDIR, TMP, TEMP, TURBO_CACHE_DIR and TURBO_TELEMETRY_DISABLED all under it', () => {
    const extras = codexSpawnEnvExtras('codex', '/tmp/scratch/codex-home', '/tmp/scratch/codex-tmp')
    expect(extras.attribution).toEqual({
      CODEX_HOME: '/tmp/scratch/codex-home',
      TMPDIR: '/tmp/scratch/codex-tmp',
      TMP: '/tmp/scratch/codex-tmp',
      TEMP: '/tmp/scratch/codex-tmp',
      // O4: turbo's cache-miss write goes inside the granted scratch, never
      // the repo-root `.turbo/` the sandbox denies.
      TURBO_CACHE_DIR: '/tmp/scratch/codex-tmp/turbo-cache',
      // O5 (#1046): turbo's telemetry ping is disabled so the confined egress
      // allowlist does not fail `bun run typecheck`.
      TURBO_TELEMETRY_DISABLED: '1'
    })
  })

  it('no scratch directory (an attended dispatch) sets none of TMPDIR/TMP/TEMP — the default parameter value', () => {
    expect(codexSpawnEnvExtras('codex', '/tmp/scratch/codex-home')).toEqual({
      attribution: { CODEX_HOME: '/tmp/scratch/codex-home' }
    })
  })

  it('a non-codex vendor never gets TMPDIR/TMP/TEMP even if a scratch directory were somehow passed', () => {
    expect(codexSpawnEnvExtras('claude', null, '/tmp/scratch/codex-tmp').attribution).toEqual({})
  })
})

describe('confinedTurboEnv — turbo telemetry is off in BOTH confined Developers (O5, #1046)', () => {
  it('the shared turbo env carries both the cache redirect and the telemetry disable', () => {
    expect(confinedTurboEnv('/tmp/scratch')).toEqual({
      TURBO_CACHE_DIR: '/tmp/scratch/turbo-cache',
      TURBO_TELEMETRY_DISABLED: '1'
    })
  })

  it("Codex's confined environment carries TURBO_TELEMETRY_DISABLED", () => {
    // `codexSpawnEnvExtras(...).attribution` IS the Codex dispatch's confined
    // environment addition — it spreads `confinedTurboEnv`.
    const codexEnv = codexSpawnEnvExtras('codex', '/tmp/scratch/codex-home', '/tmp/scratch/codex-tmp').attribution
    expect(codexEnv.TURBO_TELEMETRY_DISABLED).toBe('1')
  })

  it("Claude's confined environment carries TURBO_TELEMETRY_DISABLED too", () => {
    // `dispatchRole`'s Claude branch spreads this SAME `confinedTurboEnv` object
    // into its confined `buildWorkerEnv(...)` child environment (dispatch.ts),
    // so the variable the helper carries is exactly what the confined Claude
    // Developer's environment carries — the two agents can never drift apart.
    const claudeTurboEnv = confinedTurboEnv('/tmp/scratch/claude-tmp')
    expect(claudeTurboEnv.TURBO_TELEMETRY_DISABLED).toBe('1')
    expect(claudeTurboEnv.TURBO_CACHE_DIR).toBe('/tmp/scratch/claude-tmp/turbo-cache')
  })
})

describe('dispatchRole — Issue #625, O2: Documentation source read-gate', () => {
  const DOC_PROMPT = [
    '## Objectives',
    '',
    'O1. Fixture prompt for the Documentation read-gate.',
    '',
    '## Documentation',
    '',
    '- https://example.com/docs/fixture — the mechanism this fixture governs'
  ].join('\n')
  const TWO_SOURCE_PROMPT = `${DOC_PROMPT}\n- https://example.com/docs/second — the second mechanism this fixture governs`

  it('wires PostToolUse (WebFetch) and Stop hooks, and writes a per-run sources file, for a developer dispatch whose prompt carries `## Documentation`', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, DOC_PROMPT)

    const runId = 'doc-gate-fixture-run-id'
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`,
      { VINAYA_RUN_ID: runId }
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsPath = argv[argv.indexOf('--settings') + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: {
        PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>
        Stop: Array<{ hooks: Array<{ command: string }> }>
      }
    }
    expect(settings.hooks.PostToolUse[0]?.matcher).toBe('WebFetch')
    const logScript = settings.hooks.PostToolUse[0]?.hooks[0]?.command.slice('bun "'.length, -1) as string
    const stopScript = settings.hooks.Stop[0]?.hooks[0]?.command.slice('bun "'.length, -1) as string

    const sourcesPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'hooks',
      'developer',
      `documentation-sources-${runId}.json`
    )
    expect(JSON.parse(readFileSync(sourcesPath, 'utf8'))).toEqual([
      { source: 'https://example.com/docs/fixture', mechanism: 'the mechanism this fixture governs', objectiveIds: [] }
    ])

    // Behavioral proof: Stop refuses (exit 2, naming the source) before any
    // fetch is logged...
    const beforeFetch = spawnBudgeted(
      [stopScript],
      {
        input: JSON.stringify({ hook_event_name: 'Stop' }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'Stop hook'
    )
    expect(beforeFetch.status).toBe(2)
    expect(beforeFetch.stderr).toMatch(/example\.com\/docs\/fixture/)

    // ...the PostToolUse hook records a WebFetch call to that exact URL...
    const logged = spawnBudgeted(
      [logScript],
      {
        input: JSON.stringify({
          tool_name: 'WebFetch',
          tool_input: { url: 'https://example.com/docs/fixture' },
          tool_response: { status: 200, url: 'https://example.com/docs/fixture', bytes: 4096 }
        }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'PostToolUse hook'
    )
    expect(logged.status).toBe(0)

    // ...and Stop now passes.
    const afterFetch = spawnBudgeted(
      [stopScript],
      {
        input: JSON.stringify({ hook_event_name: 'Stop' }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'Stop hook'
    )
    expect(afterFetch.status).toBe(0)
    expect(afterFetch.stderr.trim()).toBe('')
  })

  it('gives fresh and resumed developer dispatches their respective generated schemas', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const freshPrompt = join(cwd, 'fresh.md')
    const resumedPrompt = join(cwd, 'resumed.md')
    const script = join(cwd, 'schemas.ts')
    writeFileSync(freshPrompt, TWO_SOURCE_PROMPT)
    writeFileSync(resumedPrompt, 'Fix the reported finding.')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nN=$(ls ${cwd}/argv-*.out 2>/dev/null | wc -l | tr -d ' ')\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${cwd}/argv-$N.out"\ncat > /dev/null\necho '{}'\n`
    )
    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        `await dispatchRole('developer', 'claude', ${JSON.stringify(TWO_SOURCE_PROMPT)}, { promptFile: ${JSON.stringify(freshPrompt)}, cwd: ${JSON.stringify(cwd)}, turnResultKnownFindingIds: ['R1-CR-1'] })`,
        `await dispatchRole('developer', 'claude', 'Fix the reported finding.', { promptFile: ${JSON.stringify(resumedPrompt)}, cwd: ${JSON.stringify(cwd)}, resumeId: 'session-1', turnResultKnownFindingIds: [] })`,
        // the driver's own check, run on a second-turn result reporting both sources
        `import { deliveredDocumentation } from ${JSON.stringify(dispatchLib)}`,
        `import { judgeTurnOutput } from ${JSON.stringify(join(CLI_ROOT, '..', '..', 'harness', 'processes', 'vinaya-strict', 'loops', 'dev-review', 'standalone', 'dev-review-loop', 'turn-result.ts'))}`,
        `import { writeFileSync, mkdirSync } from 'node:fs'`,
        `const hooksDir = ${JSON.stringify(join(home, '.vinaya', 'runtime', 'unresolved', 'tasks-execution', 'unscoped', 'hooks', 'developer'))}`,
        `const store = ${JSON.stringify(join(cwd, 'source-store'))}`,
        'mkdirSync(store, { recursive: true })',
        `const sources = ['https://example.com/docs/fixture', 'https://example.com/docs/second']`,
        `writeFileSync(store + '/receipts.jsonl', sources.map((source) => JSON.stringify({ sourceId: source, source, decision: 'counted' })).join('\\n') + '\\n')`,
        `const documentation = deliveredDocumentation(hooksDir, 'shared-loop-run-id', store)`,
        `const raw = { turnResult: { schemaVersion: 1, status: 'completed', summary: 'done', confidence: 80, confidenceExplanation: 'tested', addressedFindingIds: ['R1-CR-1'], sourceUses: sources.map((source) => ({ source, use: 'read' })), reportedChecks: null } }`,
        `const verdict = judgeTurnOutput({ adapter: 'claude --json-schema', event: 'result', raw }, { round: 2, knownFindingIds: ['R1-CR-1'], requireAddressedFindings: true, documentation })`,
        `writeFileSync(${JSON.stringify(join(cwd, 'verdict.json'))}, JSON.stringify(verdict))`
      ].join('\n')
    )
    runScriptWithBudget(script, cwd, {
      ...stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` }),
      VINAYA_RUN_ID: 'shared-loop-run-id'
    })

    const schema = (n: number) => {
      const argv = readArgv(join(cwd, `argv-${n}.out`))
      return JSON.parse(argv[argv.indexOf('--json-schema') + 1] as string) as Record<string, unknown>
    }
    const fresh = JSON.stringify(schema(0))
    const resumed = JSON.stringify(schema(1))
    expect(fresh).toContain('https://example.com/docs/fixture')
    expect(fresh).toContain('R1-CR-1')
    // a later turn's prompt names no sources, yet its schema requires the
    // same ones the driver checks: the run's manifest
    expect(resumed).toContain('https://example.com/docs/fixture')
    expect(resumed).toContain('https://example.com/docs/second')
    expect(resumed).toContain('"sourceUses":{"minItems":2,"maxItems":2')
    expect(JSON.parse(readFileSync(join(cwd, 'verdict.json'), 'utf8'))).toMatchObject({ ok: true })
  })

  it('gives a developer dispatch with no sources in any turn the empty-list schema', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const firstPrompt = join(cwd, 'first.md')
    const laterPrompt = join(cwd, 'later.md')
    const script = join(cwd, 'schemas.ts')
    writeFileSync(firstPrompt, '## Objectives\n\nO1. No sources here.')
    writeFileSync(laterPrompt, 'Fix the reported finding.')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nN=$(ls ${cwd}/argv-*.out 2>/dev/null | wc -l | tr -d ' ')\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${cwd}/argv-$N.out"\ncat > /dev/null\necho '{}'\n`
    )
    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        `await dispatchRole('developer', 'claude', '## Objectives\\n\\nO1. No sources here.', { promptFile: ${JSON.stringify(firstPrompt)}, cwd: ${JSON.stringify(cwd)} })`,
        `await dispatchRole('developer', 'claude', 'Fix the reported finding.', { promptFile: ${JSON.stringify(laterPrompt)}, cwd: ${JSON.stringify(cwd)}, resumeId: 'session-1' })`
      ].join('\n')
    )
    runScriptWithBudget(
      script,
      cwd,
      stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
    )
    for (const n of [0, 1]) {
      const argv = readArgv(join(cwd, `argv-${n}.out`))
      expect(argv[argv.indexOf('--json-schema') + 1]).toContain('"maxItems":0')
    }
  })

  // round 2 review, BLOCKER (O1/O2, Issue #625) — the source string this
  // gate compares a real `WebFetch` call against comes from
  // `parseIssueDocumentation`, not from this file's own logic; a doc-page
  // URL with an unspaced hyphen (the common, real shape) used to be
  // truncated there, which corrupted the sources file below and made a
  // genuine fetch of the real URL unable to ever satisfy the Stop hook.
  it('a hyphenated documentation URL is recorded, fetched and cleared correctly end to end', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const hyphenatedUrl = 'https://code.claude.com/docs/en/agent-sdk/cost-tracking'
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(
      promptFile,
      [
        '## Objectives',
        '',
        'O1. Fixture prompt for a hyphenated Documentation source.',
        '',
        '## Documentation',
        '',
        `- ${hyphenatedUrl} — the mechanism this fixture governs`
      ].join('\n')
    )

    const runId = 'doc-gate-hyphenated-url-run-id'
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`,
      { VINAYA_RUN_ID: runId }
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsPath = argv[argv.indexOf('--settings') + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }
    }
    const stopScript = settings.hooks.Stop[0]?.hooks[0]?.command.slice('bun "'.length, -1) as string
    const logScript = (
      JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> }
      }
    ).hooks.PostToolUse[0]?.hooks[0]?.command.slice('bun "'.length, -1) as string

    const sourcesPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'hooks',
      'developer',
      `documentation-sources-${runId}.json`
    )
    expect(JSON.parse(readFileSync(sourcesPath, 'utf8'))).toEqual([
      { source: hyphenatedUrl, mechanism: 'the mechanism this fixture governs', objectiveIds: [] }
    ])

    const beforeFetch = spawnBudgeted(
      [stopScript],
      {
        input: JSON.stringify({ hook_event_name: 'Stop' }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'Stop hook'
    )
    expect(beforeFetch.status).toBe(2)
    expect(beforeFetch.stderr).toContain(hyphenatedUrl)

    const logged = spawnBudgeted(
      [logScript],
      {
        input: JSON.stringify({
          tool_name: 'WebFetch',
          tool_input: { url: hyphenatedUrl },
          tool_response: { status: 200, url: hyphenatedUrl, bytes: 4096 }
        }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'PostToolUse hook'
    )
    expect(logged.status).toBe(0)

    const afterFetch = spawnBudgeted(
      [stopScript],
      {
        input: JSON.stringify({ hook_event_name: 'Stop' }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: runId }
      },
      'Stop hook'
    )
    expect(afterFetch.status).toBe(0)
    expect(afterFetch.stderr.trim()).toBe('')
  })

  it('never wires a sources file, and Stop passes trivially, for a non-developer dispatch even with the same prompt', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, DOC_PROMPT)

    const runId = 'doc-gate-non-developer-run-id'
    const r = runDispatch(
      ['code-reviewer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`,
      { VINAYA_RUN_ID: runId }
    )
    expect(r.status).toBe(0)

    const sourcesPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'hooks',
      'code-reviewer',
      `documentation-sources-${runId}.json`
    )
    expect(existsSync(sourcesPath)).toBe(false)
  })

  it('Stop passes trivially for an unrelated run_id with no sources file at all — nothing owed, never a crash', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
    const settingsPath = argv[argv.indexOf('--settings') + 1] as string
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }
    }
    const stopScript = settings.hooks.Stop[0]?.hooks[0]?.command.slice('bun "'.length, -1) as string
    const result = spawnBudgeted(
      [stopScript],
      {
        input: JSON.stringify({ hook_event_name: 'Stop' }),
        encoding: 'utf8',
        env: { ...process.env, VINAYA_RUN_ID: 'some-run-id-with-no-sources-file' }
      },
      'Stop hook'
    )
    expect(result.status).toBe(0)
  })

  it('Codex does not emit an unenforced Documentation gate warning', () => {
    {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      writeFakeBinary(binDir, 'codex', `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, DOC_PROMPT)
      const result = spawnBudgeted(
        [
          ...(programCommandLine(['dispatch']) as string[]),
          'developer',
          '--agent',
          'codex',
          '--prompt-file',
          promptFile
        ],
        {
          encoding: 'utf8',
          cwd,
          env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
        },
        'vinaya dispatch'
      )
      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain('Documentation read-gate')
      const hooksPath = join(
        home,
        '.vinaya',
        'runtime',
        'unresolved',
        'tasks-execution',
        'unscoped',
        'hooks',
        'developer',
        'codex',
        'hooks.json'
      )
      expect(existsSync(hooksPath)).toBe(true)
      const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
        hooks: {
          PostToolUse: Array<{ hooks: Array<{ command: string }> }>
          Stop: Array<{ hooks: Array<{ command: string }> }>
        }
      }
      const commandPath = (command: string) => command.slice('bun "'.length, -1)
      const sourcesFile = readdirSync(dirname(hooksPath)).find((name) => name.startsWith('documentation-sources-'))
      const hookRunId = sourcesFile?.slice('documentation-sources-'.length, -'.json'.length) as string
      const hookEnv = { ...process.env, VINAYA_RUN_ID: hookRunId }
      const blocked = spawnBudgeted(
        [commandPath(hooks.hooks.Stop[0]?.hooks[0]?.command as string)],
        { input: '{}', encoding: 'utf8', env: hookEnv },
        'Codex Stop hook'
      )
      expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: 'block' })
      const spoofed = spawnBudgeted(
        [commandPath(hooks.hooks.PostToolUse[0]?.hooks[0]?.command as string)],
        {
          input: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'echo https://example.com/docs/fixture' },
            tool_response: { output: 'https://example.com/docs/fixture' }
          }),
          encoding: 'utf8',
          env: hookEnv
        },
        'Codex unrelated PostToolUse hook'
      )
      expect(spoofed.status).toBe(0)
      const stillBlocked = spawnBudgeted(
        [commandPath(hooks.hooks.Stop[0]?.hooks[0]?.command as string)],
        { input: '{}', encoding: 'utf8', env: hookEnv },
        'Codex Stop hook after spoof'
      )
      expect(JSON.parse(stillBlocked.stdout)).toMatchObject({ decision: 'block' })
      const mixedCurl = spawnBudgeted(
        [commandPath(hooks.hooks.PostToolUse[0]?.hooks[0]?.command as string)],
        {
          input: JSON.stringify({
            tool_name: 'Bash',
            tool_input: {
              command: 'curl -L https://unrelated.example && echo https://example.com/docs/fixture'
            },
            tool_response: { output: 'https://example.com/docs/fixture' }
          }),
          encoding: 'utf8',
          env: hookEnv
        },
        'Codex mixed curl PostToolUse hook'
      )
      expect(mixedCurl.status).toBe(0)
      const blockedAfterMixedCurl = spawnBudgeted(
        [commandPath(hooks.hooks.Stop[0]?.hooks[0]?.command as string)],
        { input: '{}', encoding: 'utf8', env: hookEnv },
        'Codex Stop hook after mixed curl'
      )
      expect(JSON.parse(blockedAfterMixedCurl.stdout)).toMatchObject({ decision: 'block' })
      const recorded = spawnBudgeted(
        [commandPath(hooks.hooks.PostToolUse[0]?.hooks[0]?.command as string)],
        {
          input: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'curl -L https://example.com/docs/fixture' },
            tool_response: { output: 'fetched documentation body' }
          }),
          encoding: 'utf8',
          env: hookEnv
        },
        'Codex Bash/curl PostToolUse hook'
      )
      expect(recorded.status).toBe(0)
      const allowed = spawnBudgeted(
        [commandPath(hooks.hooks.Stop[0]?.hooks[0]?.command as string)],
        { input: '{}', encoding: 'utf8', env: hookEnv },
        'Codex Stop hook'
      )
      expect(allowed.stdout).toBe('')
    }

    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'codex', `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const r = spawnBudgeted(
      [...(programCommandLine(['dispatch']) as string[]), 'developer', '--agent', 'codex', '--prompt-file', promptFile],
      {
        encoding: 'utf8',
        cwd,
        env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
      },
      'vinaya dispatch'
    )
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('Documentation read-gate')
  })
})

describe('dispatchRole — container mode on a faked Linux host with no bubblewrap', () => {
  const DISPATCH_LIB = join(
    CLI_ROOT,
    '..',
    '..',
    'harness',
    'processes',
    'vinaya-strict',
    'loops',
    'dev-review',
    'dispatch',
    'dispatch.ts'
  )
  /** Links to the host tools the fixture runs, so no `bwrap` or `socat` the host holds is on the child's PATH. */
  const toolsPath = () => {
    const dir = tempDir('vinaya-container-tools-')
    const real = (process.env.PATH ?? '').split(':').filter(Boolean)
    for (const tool of ['bun', 'git', 'sh', 'cat', 'which', 'node']) {
      const found = real.map((d) => join(d, tool)).find((p) => existsSync(p))
      if (found) symlinkSync(found, join(dir, tool))
    }
    return dir
  }

  function runContained(
    probe: { dockerEnv: boolean; dirs: string[] },
    options: { containerMode: boolean; token?: string }
  ) {
    const home = tempDir('vinaya-container-home-')
    const cwd = tempDir('vinaya-container-cwd-')
    const binDir = tempDir('vinaya-container-bin-')
    const calls = join(cwd, 'calls.log')
    const childEnv = join(cwd, 'child.env')
    const promptFile = join(cwd, 'prompt.txt')
    const resultFile = join(cwd, 'result.json')
    writeFileSync(promptFile, 'do the thing')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncase "$*" in *vinaya-sandbox-probe*) echo probe >> "${calls}";; esac\necho spawn >> "${calls}"\n/usr/bin/env > "${childEnv}"\ncat > /dev/null\nprintf '%s' '{"session_id":"s","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    const script = join(cwd, 'dispatch.ts')
    writeFileSync(
      script,
      [
        "import { writeFileSync } from 'node:fs'",
        "Object.defineProperty(process, 'platform', { value: 'linux' })",
        `const dispatch = await import(${JSON.stringify(DISPATCH_LIB)})`,
        'dispatch.CONTAINER_BOUNDARY_PROBE_DEPS.probe = {',
        "  platform: () => 'linux',",
        `  dockerEnvPresent: () => ${probe.dockerEnv},`,
        `  socketDirectories: () => ${JSON.stringify(probe.dirs)}`,
        '}',
        "const result = await dispatch.dispatchRole('developer', 'claude', 'do the thing', {",
        `  promptFile: ${JSON.stringify(promptFile)},`,
        `  cwd: ${JSON.stringify(cwd)},`,
        '  unattended: true,',
        `  containerMode: ${options.containerMode}`,
        '})',
        `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result))`
      ].join('\n')
    )
    const env: NodeJS.ProcessEnv = {
      ...stripVinayaEnv(process.env),
      HOME: home,
      PATH: `${binDir}:${toolsPath()}`,
      ANTHROPIC_API_KEY: 'api-key-fixture'
    }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    if (options.token !== undefined) env.CLAUDE_CODE_OAUTH_TOKEN = options.token
    const child = spawnBudgeted([script], { cwd, encoding: 'utf8', env }, 'container-mode dispatch')
    expect(child.status, child.stderr).toBe(0)
    return {
      stderr: child.stderr,
      result: JSON.parse(readFileSync(resultFile, 'utf8')) as { failureReason?: string },
      calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
      childEnv: existsSync(childEnv)
        ? Object.fromEntries(
            readFileSync(childEnv, 'utf8')
              .split('\n')
              .filter((line) => line.includes('='))
              .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
          )
        : null
    }
  }
  const holds = { dockerEnv: true, dirs: [] as string[] }

  it('dispatches with no sandbox probe, authenticated from the token by name and never an API key, when every condition holds', () => {
    const run = runContained(holds, { containerMode: true, token: 'subscription-token-fixture' })
    expect(run.result.failureReason).toBeUndefined()
    expect(run.calls).toEqual(['spawn'])
    expect(run.stderr).toContain('container mode — this one-task container is the boundary')
    expect(run.childEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('subscription-token-fixture')
    expect(run.childEnv?.CLAUDE_FORCE_OAUTH).toBe('1')
    expect(run.childEnv?.ANTHROPIC_API_KEY).toBeUndefined()
  }, 40_000)

  it('refuses unconfined, as today, when the trial entry did not set container mode', () => {
    const run = runContained(holds, { containerMode: false, token: 'subscription-token-fixture' })
    expect(run.result.failureReason).toBe('refused')
    expect(run.calls).toEqual([])
    expect(run.stderr).toContain('refused — unattended Claude requires a confined worker sandbox')
    expect(run.stderr).not.toContain('The container is not the boundary')
  }, 40_000)

  it('refuses unconfined when /.dockerenv is absent, or another driver-run socket directory exists', () => {
    for (const [probe, reason] of [
      [{ dockerEnv: false, dirs: [] }, '/.dockerenv'],
      [{ dockerEnv: true, dirs: [join(devToolsSocketRoot(), 'other')] }, 'not the only task in the container']
    ] as const) {
      const run = runContained(
        { dockerEnv: probe.dockerEnv, dirs: [...probe.dirs] },
        {
          containerMode: true,
          token: 'subscription-token-fixture'
        }
      )
      expect(run.result.failureReason).toBe('refused')
      expect(run.calls).toEqual([])
      expect(run.stderr).toContain('refused — unattended Claude requires a confined worker sandbox')
      expect(run.stderr).toContain(reason)
    }
  }, 60_000)

  it('refuses a container-mode Claude dispatch with no subscription token, before any spawn', () => {
    const run = runContained(holds, { containerMode: true })
    expect(run.result.failureReason).toBe('refused')
    expect(run.calls).toEqual([])
    expect(run.stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN, which is unset')
  }, 40_000)
})

describe('process hygiene (Issue #670) — the file leaves no fake vendor process behind', () => {
  it('no NEW process — beyond whatever the host already carried before this file ran — still carries a vinaya-dispatch-bin- path in its command line', () => {
    const newSurvivors = vendorProcessSurvivors().filter((line) => !preExistingVendorSurvivors.has(line))
    expect(newSurvivors).toEqual([])
  })
})
