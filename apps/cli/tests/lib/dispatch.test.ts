/**
 * `dispatchRole`'s spawn/timeout/attribution behavior (task 3,
 * `vinaya-log-v1`, Issue #406) — exercised through the real `vinaya dispatch`
 * CLI entry point (`execFileSync('bun', [INDEX, ...])`, same discipline as
 * `apps/cli/tests/commands/issue.test.ts`'s fake `gh`), never by importing
 * `dispatchRole` in-process: `apps/cli/src/lib/config.ts`'s
 * `GLOBAL_VINAYA_HOME` is a module-level constant frozen at first import from
 * whatever `HOME` happens to be, and `@attalabs/aeg-forge-state`'s
 * `resolveRepo()` caches its result for the process lifetime — an in-process
 * `bun:test` run sharing either with another test file in the same run could
 * silently pollute the real developer machine's own `~/.vinaya/outbox/` or
 * read a stale cached repo. A fresh subprocess per test sidesteps both: a
 * scratch `HOME`, and a scratch, non-git `cwd` so `resolveRepo()` resolves
 * `null` (the `unresolved/` outbox bucket) every time.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { readdirSync, statSync } from 'node:fs'
import {
  DEFAULT_TIMEOUT_MS,
  identifyVendorFromModelShape,
  parseClaudeModel,
  parseClaudeResumeId,
  parseClaudeUsage,
  parseGeminiModel,
  parseGeminiUsage,
  renderClaudeEvent,
  renderGeminiEvent,
  resolveClassModel,
  HEARTBEAT_INTERVAL_MS,
  MAX_TEE_BYTES,
  openOutputTee,
  timeoutWarningLeadMs
} from '../../src/lib/dispatch.js'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

/**
 * The ambient `PATH`, minus any directory that carries a REAL `claude`/
 * `codex`/`gemini` binary — this authoring machine has all three installed
 * (`aeg-root/roles/developer.md` pre-flight `which` check), and a naive
 * `process.env.PATH` passthrough would let the "absent"/"not executable"
 * defeat cases silently find and exercise the real vendor CLI instead of the
 * fake fixture. Still carries `bun`'s own directory and the usual system
 * dirs, so the outer `execFileSync('bun', ...)` and `which`/`env`/`cat`
 * inside the fake scripts keep working.
 */
function pathWithoutRealVendors(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  return dirs.filter((d) => !['claude', 'codex', 'gemini'].some((vendor) => existsSync(join(d, vendor)))).join(':')
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type CliResult = { status: number; stdout: string; stderr: string }

function runDispatch(
  args: string[],
  cwd: string,
  home: string,
  path: string,
  extraEnv: Record<string, string> = {}
): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, 'dispatch', ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, PATH: path, ...extraEnv }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

function writeFakeBinary(dir: string, name: string, script: string): string {
  const p = join(dir, name)
  writeFileSync(p, script)
  chmodSync(p, 0o755)
  return p
}

function outboxLines(home: string, issue: number | 'none'): unknown[] {
  const p = join(home, '.vinaya', 'outbox', 'unresolved', `${issue}.ndjson`)
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const PROMPT_FILE_CONTENT = 'do the thing'

describe('dispatchRole — a successful dispatch', () => {
  it('starts the child with attribution on its env, hashes the prompt, and parses printed usage', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const envOut = join(cwd, 'env.out')
    const stdinOut = join(cwd, 'stdin.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nenv > "${envOut}"\ncat > "${stdinOut}"\necho '{"usage":{"input_tokens":11,"output_tokens":22}}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    // `--task` is given (to confirm `VINAYA_TASK` propagates) but no `gh` is
    // provided on PATH and `cwd` is not a git repo, so `dispatchCommand`'s
    // trailing `log flush` refuses locally — safely, before any network
    // call (confirmed live: `gh issue comment` outside a git repo fails on
    // repo resolution alone) — with exit `2`. That is deliberate here: a
    // SUCCEEDING flush would truncate the very outbox lines this test reads
    // below; `--task`'s effect on env attribution and the log lines
    // themselves is this test's concern, not the flush (see
    // `apps/cli/tests/commands/dispatch.test.ts` for that).
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9001'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(2)

    const env = readFileSync(envOut, 'utf8')
    expect(env).toMatch(/^VINAYA_ROLE=developer$/m)
    expect(env).toMatch(/^VINAYA_TASK=9001$/m)
    expect(env).toMatch(/^VINAYA_RUN_ID=.+$/m)

    expect(readFileSync(stdinOut, 'utf8')).toBe(PROMPT_FILE_CONTENT)

    const lines = outboxLines(home, 9001) as Array<Record<string, unknown>>
    const dispatched = lines.find((l) => l.event === 'dispatched')
    const outcome = lines.find((l) => l.event === 'outcome_received')
    expect(dispatched).toBeDefined()
    expect((dispatched as { prompt_hash: string }).prompt_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(outcome).toBeDefined()
    expect((outcome as { usage: { input: number; output: number } }).usage).toEqual({ input: 11, output: 22 })
    expect((outcome as { target_role: string }).target_role).toBe('developer')
    // O2: the vendor name is never recorded in this field — the defect this
    // task closes. No `--model` was given here, so the placeholder for "the
    // vendor's own default ran" is recorded instead of `'claude'`.
    expect((outcome as { model: string }).model).toBe('default')
  })
})

describe('dispatchRole — a crashing child', () => {
  it('logs dispatch_failed with reason crash on a non-zero exit', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', '#!/bin/sh\ncat > /dev/null\nexit 7\n')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed')
    expect(failed).toBeDefined()
    expect((failed as { reason: string }).reason).toBe('crash')
  })
})

describe('dispatchRole — no matching binary on PATH', () => {
  it('refuses by name before any spawn attempt, logging only dispatch_failed', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const emptyBinDir = tempDir('vinaya-dispatch-empty-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    // `which` itself must resolve (from a real system dir) so this exercises
    // "claude absent from PATH", not "which itself missing" — same refused
    // outcome either way, but for the right reason.
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${emptyBinDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect(lines[0]?.event).toBe('dispatch_failed')
    expect((lines[0] as { reason: string }).reason).toBe('refused')
  })
})

describe('dispatchRole — present but not executable', () => {
  it('refuses the same way as absent, never spawning', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const p = join(binDir, 'claude')
    writeFileSync(p, '#!/bin/sh\nexit 0\n')
    chmodSync(p, 0o644) // present, not executable

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)
    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect((lines[0] as { reason: string }).reason).toBe('refused')
  })
})

describe('dispatchRole — timeout ceiling', () => {
  it('SIGTERMs a child that ignores it, then SIGKILLs after the grace window, and the pid is actually gone', () => {
    // Real wall time: `timeoutMs` (1000) + the hardcoded `SIGKILL_GRACE_MS`
    // (5000) + process overhead — past bun:test's default 5000ms per-test
    // timeout, so this test needs its own explicit budget (3rd `it` arg).
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const pidFile = join(cwd, 'pid')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\necho $$ > "${pidFile}"\ntrap '' TERM\ncat > /dev/null &\nsleep 30\n`)
    // 2500ms, not a shorter value: the shell itself needs real wall time —
    // under this bun:test file's own contention from other subprocess-heavy
    // tests, more than 1000ms — to start and reach its own `trap` statement
    // before `SIGTERM` arrives. A too-short ceiling kills the shell via
    // SIGTERM's default disposition before it ever traps the signal,
    // producing a false pass for the wrong reason (found live, authoring
    // this test: 300ms failed consistently, 1000ms failed intermittently
    // under full-suite contention).
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500 } }))
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed')
    expect((failed as { reason: string }).reason).toBe('timeout')

    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)

  it('reports timeout even when the child exits cleanly on SIGTERM alone (no SIGKILL needed)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null &\ntrap 'exit 0' TERM\nsleep 30\n`)
    // Same startup-latency reasoning as the test above: the shell needs
    // real wall time, under this file's own subprocess contention, to
    // reach its own `trap` before `SIGTERM` arrives.
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500 } }))
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)
    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed')
    expect((failed as { reason: string }).reason).toBe('timeout')
  }, 10_000)

  // O10 — a run's token record survives the manner of its death: the parent
  // captures usage from the accumulated stdout AT THE MOMENT it ends the
  // child, not only on a clean exit.
  it('a killed child still leaves real usage figures in the dispatch_failed line, not a hardcoded null', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    // Prints a complete stream-json usage line BEFORE going unresponsive —
    // the exact shape `parseClaudeUsage` reads. `stdout` is unbuffered on a
    // bare `echo`, so this line reaches the parent's `stdoutBuf` well before
    // the timeout ceiling fires.
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\necho '{"usage":{"input_tokens":184327,"output_tokens":22190}}'\ntrap '' TERM\ncat > /dev/null &\nsleep 30\n`
    )
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500 } }))
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed') as
      | { reason: string; usage: { input: number; output: number } | null }
      | undefined
    expect(failed?.reason).toBe('timeout')
    expect(failed?.usage).toEqual({ input: 184327, output: 22190 })
  }, 15_000)
})

describe('dispatchRole — stderr content never decides the outcome', () => {
  it('a child that writes to stderr but exits 0 is still outcome_received, not a failure', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho 'noisy warning' 1>&2\necho '{}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    expect(lines.find((l) => l.event === 'outcome_received')).toBeDefined()
    expect(lines.find((l) => l.event === 'dispatch_failed')).toBeUndefined()
  })
})

describe('dispatchRole — two dispatches in the same process', () => {
  it('each gets its own run_id via its own createLogSink call, with no shared mutable state', () => {
    // Calls `dispatchRole` twice from ONE dedicated subprocess (not two CLI
    // invocations) — the defeat case is about within-process state, which a
    // separate `bun dispatch` invocation per call would not exercise at all.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
    const script = join(cwd, 'two-dispatches.ts')
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)} }`,
        `await dispatchRole('developer', 'claude', 'p', opts)`,
        `await dispatchRole('developer', 'claude', 'p', opts)`
      ].join('\n')
    )

    execFileSync('bun', [script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` }
    })

    // Each call's own `dispatched`/`outcome_received` pair legitimately
    // shares ONE run_id (one `createLogSink()` call per `dispatchRole`
    // invocation) — the invariant under test is exactly two DISTINCT
    // run_ids (one per call), not that every line's run_id is unique.
    const lines = outboxLines(home, 'none') as Array<{ meta: { run_id: string } }>
    expect(lines.length).toBe(4)
    const runIds = new Set(lines.map((l) => l.meta.run_id))
    expect(runIds.size).toBe(2)
  })
})

describe('dispatchRole — a shared run_id (a nested dispatch inheriting VINAYA_RUN_ID)', () => {
  it('correlates each of two concurrent dispatches by effect_id, not run_id alone (code-review finding, PR #441)', async () => {
    // A dispatched role's own `vinaya dispatch` call inherits its parent's
    // `VINAYA_RUN_ID` via the child's env (by design — no loop feature
    // needed, reachable today) — `createLogSink`'s `runId = deps.env().
    // VINAYA_RUN_ID || randomUUID()` then picks that inherited value
    // straight back up, so two concurrent dispatches CAN legitimately
    // share one run_id. Simulated here by exporting `VINAYA_RUN_ID` before
    // both calls, rather than actually nesting a real child dispatch.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '{"usage":{"input_tokens":11,"output_tokens":22}}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
    const script = join(cwd, 'shared-run-id.ts')
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        `process.env.VINAYA_RUN_ID = 'shared-run-id-fixture'`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)} }`,
        // Concurrent, not sequential — this is what makes a shared
        // run_id's two 'dispatched'/'outcome_received' pairs actually
        // race for the same (run_id, kind, event) match window.
        'await Promise.all([',
        `  dispatchRole('developer', 'claude', 'p', opts),`,
        `  dispatchRole('code-reviewer', 'claude', 'p', opts)`,
        '])'
      ].join('\n')
    )

    execFileSync('bun', [script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` }
    })

    const lines = outboxLines(home, 'none') as Array<{
      meta: { run_id: string }
      effect_id: string
      event: string
      target_role: string
    }>
    expect(lines.length).toBe(4)

    // Both calls really did share one run_id — the scenario under test,
    // not a fixture that accidentally avoided it.
    const runIds = new Set(lines.map((l) => l.meta.run_id))
    expect(runIds).toEqual(new Set(['shared-run-id-fixture']))

    // Despite the shared run_id, every line is unambiguously attributable
    // to its own call via effect_id: exactly two distinct effect_ids, each
    // carrying exactly one 'dispatched' and one 'outcome_received' line,
    // and each effect_id's lines agree on which role they belong to (never
    // a 'developer' line and a 'code-reviewer' line sharing one effect_id).
    const byEffectId = new Map<string, typeof lines>()
    for (const line of lines) {
      const group = byEffectId.get(line.effect_id) ?? []
      group.push(line)
      byEffectId.set(line.effect_id, group)
    }
    expect(byEffectId.size).toBe(2)
    for (const group of byEffectId.values()) {
      expect(group.map((l) => l.event).sort()).toEqual(['dispatched', 'outcome_received'])
      expect(new Set(group.map((l) => l.target_role)).size).toBe(1)
    }
    expect(new Set(lines.map((l) => l.target_role))).toEqual(new Set(['developer', 'code-reviewer']))
  }, 10_000)
})

/** One argv element per line, preserving an empty-string element (gemini's `-p ''`) as a blank line — unambiguous, unlike a single space-joined `echo "$@"`. */
function readArgv(path: string): string[] {
  return readFileSync(path, 'utf8').replace(/\n$/, '').split('\n')
}

type ResumeVendorFixture = {
  agent: 'claude' | 'codex' | 'gemini'
  /** stdout a real first dispatch prints, carrying `synthId` as that vendor's own resume identifier. */
  firstStdout: (synthId: string) => string
  /** The exact argv `dispatchRole` must pass the vendor's binary for a `--resume <id>` dispatch. */
  resumeArgv: (id: string) => string[]
}

const RESUME_VENDOR_FIXTURES: ResumeVendorFixture[] = [
  {
    agent: 'claude',
    firstStdout: (id) => `{"session_id":"${id}","usage":{"input_tokens":1,"output_tokens":1}}`,
    // `--verbose` is required by the CLI when `-p` is paired with
    // `stream-json`; the resume path streams for the same reason the first
    // turn does (Issue #447, O5).
    resumeArgv: (id) => ['-p', '-r', id, '--verbose', '--output-format', 'stream-json']
  },
  {
    agent: 'codex',
    firstStdout: (id) =>
      `{"type":"thread.started","thread_id":"${id}"}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
    resumeArgv: (id) => ['exec', 'resume', id, '--json', '-']
  },
  {
    agent: 'gemini',
    firstStdout: (id) => `{"session_id":"${id}"}`,
    // Streams for the same reason claude does (Issue #447, O5); shape
    // verified against a real gemini run, not assumed.
    resumeArgv: (id) => ['-p', '', '--resume', id, '--output-format', 'stream-json', '--skip-trust']
  }
]

describe('dispatchRole — resume identifier (round-trip, per vendor)', () => {
  for (const fixture of RESUME_VENDOR_FIXTURES) {
    it(`${fixture.agent}: a successful dispatch returns resumeId, and --resume <id> reaches the child as that vendor's own resume argv`, () => {
      const synthId = '11111111-1111-1111-1111-111111111111'
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      const argvOut = join(cwd, 'argv.out')
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      // First dispatch: no `--resume` — the fake binary ignores its argv and
      // prints the vendor's real first-dispatch shape carrying `synthId`.
      writeFakeBinary(
        binDir,
        fixture.agent,
        `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${fixture.firstStdout(synthId)}'\nexit 0\n`
      )
      const first = runDispatch(
        ['developer', '--agent', fixture.agent, '--prompt-file', promptFile, '--json'],
        cwd,
        home,
        path
      )
      expect(first.status).toBe(0)
      expect((JSON.parse(first.stdout) as { data: { resumeId: string | null } }).data.resumeId).toBe(synthId)

      // Second dispatch: `--resume <synthId>` — the fake binary now records
      // its own argv, one element per line, so the exact resume shape is
      // checkable rather than merely "some flag we hoped for."
      writeFakeBinary(
        binDir,
        fixture.agent,
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argvOut}"\ncat > /dev/null\nprintf '%s' '${fixture.firstStdout(synthId)}'\nexit 0\n`
      )
      const second = runDispatch(
        ['developer', '--agent', fixture.agent, '--prompt-file', promptFile, '--resume', synthId, '--json'],
        cwd,
        home,
        path
      )
      expect(second.status).toBe(0)
      expect(readArgv(argvOut)).toEqual(fixture.resumeArgv(synthId))
    })
  }
})

/**
 * O8 (Issue #454). Answering a stopped agent goes through the resume path
 * that already exists (`--resume <id> --prompt-file <answer>`) — the gap
 * this closes is that the id it needs was never recorded anywhere a later,
 * separate invocation could find it, only printed to the window that ran
 * the dispatch that produced it.
 */
describe('dispatchRole — resume state durably recorded (O8)', () => {
  it('a successful dispatch with a resume id writes a record a later invocation can find, keyed by role/vendor/task, overwritten by the next run', () => {
    const synthId1 = '22222222-2222-2222-2222-222222222222'
    const synthId2 = '33333333-3333-3333-3333-333333333333'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`
    const recordPath = join(home, '.vinaya', 'dispatch-resume', 'unresolved', 'developer-claude-issue454.json')

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId1}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    // `--task` makes `dispatchCommand` also try `vinaya log flush` with no
    // `gh` on PATH outside a git repo — refused locally with exit `2`, the
    // same deliberate shape the first `dispatchRole` describe block above
    // documents. The resume record is written by `dispatchRole` itself,
    // before that flush step ever runs, so it exists regardless.
    const first = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '454'],
      cwd,
      home,
      path
    )
    expect(first.status).toBe(2)

    const record1 = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      resumeId: string
      role: string
      agent: string
      task: number | null
      pr: number | null
    }
    expect(record1.resumeId).toBe(synthId1)
    expect(record1.role).toBe('developer')
    expect(record1.agent).toBe('claude')
    expect(record1.task).toBe(454)
    expect(record1.pr).toBeNull()

    // Owner-only, matching the tee file's own permission discipline.
    expect(statSync(recordPath).mode & 0o777).toBe(0o600)

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId2}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    const second = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '454'],
      cwd,
      home,
      path
    )
    expect(second.status).toBe(2)

    // Overwritten, not appended — only the latest session is resumable.
    const record2 = JSON.parse(readFileSync(recordPath, 'utf8')) as { resumeId: string }
    expect(record2.resumeId).toBe(synthId2)
  })

  it('a dispatch with neither --task nor --pr records the id under an "unscoped" key', () => {
    const synthId = '44444444-4444-4444-4444-444444444444'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    const result = runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(result.status).toBe(0)

    const recordPath = join(home, '.vinaya', 'dispatch-resume', 'unresolved', 'developer-claude-unscoped.json')
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { resumeId: string; task: number | null }
    expect(record.resumeId).toBe(synthId)
    expect(record.task).toBeNull()
  })

  it('two different repos dispatching the same task number get two distinct records, keyed by repo (O5, #456)', () => {
    const synthIdA = '55555555-5555-5555-5555-555555555555'
    const synthIdB = '66666666-6666-6666-6666-666666666666'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthIdA}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9'], cwd, home, path, {
      AEG_REPO: 'acme/tranche-a'
    })

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthIdB}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9'], cwd, home, path, {
      AEG_REPO: 'acme/tranche-b'
    })

    // Same tranche-local-looking task number (9), two different repos —
    // this is the live bug O5 closes: before the repo segment existed, the
    // second dispatch's record would have overwritten the first's.
    const recordA = JSON.parse(
      readFileSync(join(home, '.vinaya', 'dispatch-resume', 'acme-tranche-a', 'developer-claude-issue9.json'), 'utf8')
    ) as { resumeId: string }
    const recordB = JSON.parse(
      readFileSync(join(home, '.vinaya', 'dispatch-resume', 'acme-tranche-b', 'developer-claude-issue9.json'), 'utf8')
    ) as { resumeId: string }
    expect(recordA.resumeId).toBe(synthIdA)
    expect(recordB.resumeId).toBe(synthIdB)
  })

  it('an unsafe AEG_REPO value falls back to the unresolved bucket rather than escaping it (O5, #456)', () => {
    const synthId = '77777777-7777-7777-7777-777777777777'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9'], cwd, home, path, {
      AEG_REPO: 'acme/../../../etc'
    })

    const recordPath = join(home, '.vinaya', 'dispatch-resume', 'unresolved', 'developer-claude-issue9.json')
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { resumeId: string }
    expect(record.resumeId).toBe(synthId)
    expect(existsSync(join(home, '.vinaya', 'dispatch-resume', 'etc'))).toBe(false)
  })

  it('a crashing child writes no resume record — there is no session to resume', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    writeFakeBinary(binDir, 'claude', '#!/bin/sh\ncat > /dev/null\nexit 7\n')
    const result = runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(result.status).toBe(1)
    expect(existsSync(join(home, '.vinaya', 'dispatch-resume'))).toBe(false)
  })
})

/**
 * Observability (Issue #450). The four behaviours this task added were shipped
 * with no test of their own; these cover each one at the level it can honestly
 * be reached. `timeoutWarningLeadMs` and `openOutputTee` are imported directly
 * — they are pure-enough units that need no spawned process, unlike the
 * `dispatchRole` cases above, which must go through the real CLI entry point
 * for the reason that file's own header records.
 */
/** Where `openOutputTee` writes. Derived, never hardcoded, so a moved home moves the test with it. */
const TEE_DIR = join(homedir(), '.vinaya', 'dispatch-output')

/**
 * Read a teed file once the expected marker has landed. `createWriteStream`
 * flushes on the event loop, so this awaits between polls — a synchronous spin
 * blocks the very flush it is waiting for.
 */
async function readWhenReady(path: string, marker: string): Promise<string> {
  const deadline = Date.now() + 3000
  let contents = ''
  while (Date.now() < deadline) {
    try {
      contents = readFileSync(path, 'utf8')
      if (contents.includes(marker)) break
    } catch {
      // not created yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return contents
}

describe('dispatch observability (#450)', () => {
  it('the shipped default deadline is four hours, not one', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(14_400_000)
    // The regression this pins: a one-hour default killed a dispatched agent
    // that had made five commits and was still working.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(3_600_000)
  })

  it('warns before the deadline, never after it, and never at the deadline itself', () => {
    // Capped lead for a long run: four hours warns five minutes out.
    expect(timeoutWarningLeadMs(14_400_000)).toBe(300_000)
    // Short runs fall back to half the budget, so the warning still lands
    // while there is time to act rather than as the kill arrives.
    expect(timeoutWarningLeadMs(60_000)).toBe(30_000)
    expect(timeoutWarningLeadMs(1_000)).toBe(500)
    // The invariant that matters, across the whole range: strictly inside the
    // budget, so a warning is never scheduled at or past the SIGTERM.
    for (const budget of [1_000, 60_000, 600_000, 3_600_000, 14_400_000]) {
      const lead = timeoutWarningLeadMs(budget)
      expect(lead).toBeGreaterThan(0)
      expect(lead).toBeLessThan(budget)
    }
  })

  it('the heartbeat interval is short enough to distinguish working from hung', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000)
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0)
  })

  it('tees child output to a readable file keyed by the run, and reads back what was written', async () => {
    const effectId = `test-${randomUUID()}`
    const tee = openOutputTee(effectId)
    expect(tee.path).not.toBeNull()
    expect(tee.path as string).toContain(effectId)

    tee.write(Buffer.from('first chunk\n'))
    tee.write(Buffer.from('second chunk\n'))
    tee.end()

    // The point of the tee is that a human can read it WHILE the run is alive,
    // so the bytes must actually reach the file rather than sit in a buffer.
    // `createWriteStream` flushes on the event loop, so this polls with an
    // await — a synchronous spin would block the very flush it waits for,
    // which is exactly how this test first failed.
    const deadline = Date.now() + 3000
    let contents = ''
    while (Date.now() < deadline) {
      try {
        contents = readFileSync(tee.path as string, 'utf8')
        if (contents.includes('second chunk')) break
      } catch {
        // not created yet
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(contents).toContain('first chunk')
    expect(contents).toContain('second chunk')
    rmSync(tee.path as string, { force: true })
  })

  it('refuses a traversal id outright, writing no file anywhere', () => {
    // The previous version of this test passed a traversal string and asserted
    // only that it did not throw — which is true of a function that happily
    // writes outside its directory. Assert the containment the name claims.
    const before = existsSync(TEE_DIR) ? readdirSync(TEE_DIR) : []
    for (const bad of ['nested/../../escape-attempt', '../escape', 'a/b', '', '.']) {
      const tee = openOutputTee(bad)
      expect(tee.path).toBeNull()
      tee.write(Buffer.from('must not be written'))
      tee.end()
    }
    const after = existsSync(TEE_DIR) ? readdirSync(TEE_DIR) : []
    expect(after).toEqual(before)
  })

  it('redacts credentials before they reach the file', async () => {
    const effectId = `test-${randomUUID()}`
    const tee = openOutputTee(effectId)
    // Exactly what a dispatched agent prints when it runs `env` or `gh auth token`.
    tee.write(Buffer.from('GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz\n'))
    tee.write(Buffer.from('Authorization: Bearer sk-secret-value-here\n'))
    tee.write(Buffer.from('harmless line\n'))
    tee.end()

    const contents = await readWhenReady(tee.path as string, 'harmless line')
    expect(contents).toContain('harmless line')
    expect(contents).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz')
    expect(contents).not.toContain('sk-secret-value-here')
    rmSync(tee.path as string, { force: true })
  })

  it('creates the log owner-only, inside an owner-only directory', async () => {
    const effectId = `test-${randomUUID()}`
    const tee = openOutputTee(effectId)
    tee.write(Buffer.from('x\n'))
    tee.end()
    await readWhenReady(tee.path as string, 'x')
    expect(statSync(tee.path as string).mode & 0o777).toBe(0o600)
    expect(statSync(TEE_DIR).mode & 0o777).toBe(0o700)
    rmSync(tee.path as string, { force: true })
  })

  it('stops writing at the size cap instead of growing without bound', async () => {
    const effectId = `test-${randomUUID()}`
    const tee = openOutputTee(effectId)
    const chunk = Buffer.from(`${'y'.repeat(64 * 1024)}\n`)
    for (let i = 0; i < Math.ceil(MAX_TEE_BYTES / chunk.length) + 8; i++) tee.write(chunk)
    tee.end()
    await readWhenReady(tee.path as string, 'y')
    // Bounded by the cap. Slack is one chunk (the write that crosses the cap
    // is allowed to complete) plus the carry tail flushed at `end`.
    expect(statSync(tee.path as string).size).toBeLessThanOrEqual(MAX_TEE_BYTES + chunk.length + 512)
    // And it really did stop: without a cap this would be ~9 chunks larger.
    expect(statSync(tee.path as string).size).toBeLessThan(chunk.length * (Math.ceil(MAX_TEE_BYTES / chunk.length) + 8))
    rmSync(tee.path as string, { force: true })
  })
})

/**
 * The wiring, not the units. Every test above this block exercises
 * `openOutputTee`/`timeoutWarningLeadMs` directly; this one drives a REAL
 * `vinaya dispatch` against a fake vendor and asserts that the tee is
 * actually connected to the child's streams, lands under the run's own HOME,
 * and scrubs what the child printed. A unit test of the tee cannot catch the
 * tee being wired to nothing.
 */
describe('dispatch observability — wired through a real run (#450)', () => {
  it("tees the child's real output to HOME, redacted, and names the file on stderr", () => {
    const home = tempDir('vinaya-tee-home-')
    const cwd = tempDir('vinaya-tee-cwd-')
    const binDir = tempDir('vinaya-tee-bin-')
    // A vendor that prints a credential on stdout and a line on stderr —
    // exactly the shape of a coding agent running `env` mid-task.
    writeFakeBinary(
      binDir,
      'claude',
      '#!/bin/sh\ncat > /dev/null\n' +
        "echo 'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz'\n" +
        "echo 'diagnostic line on stderr' >&2\n" +
        'echo \'{"usage":{"input_tokens":1,"output_tokens":2}}\'\nexit 0\n'
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    // `spawnSync`, not the `runDispatch` helper above: that helper returns
    // `stderr: ''` on a successful run (`execFileSync` yields stdout only),
    // and the operator lines this test is about are written to stderr.
    const r = spawnSync('bun', [INDEX, 'dispatch', 'developer', '--agent', 'claude', '--prompt-file', promptFile], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` }
    })
    expect(r.status).toBe(0)

    // The path is announced once, correlated with the run's effect id.
    expect(r.stderr).toContain('output teed to')
    expect(r.stderr).toMatch(/\[vinaya dispatch [0-9a-f-]{36}\]/)

    const teeDir = join(home, '.vinaya', 'dispatch-output')
    const logs = readdirSync(teeDir)
    expect(logs).toHaveLength(1)
    const contents = readFileSync(join(teeDir, logs[0] as string), 'utf8')

    // Wired to BOTH streams — stderr was discarded entirely before this task.
    expect(contents).toContain('diagnostic line on stderr')
    // And scrubbed on the way: the child printed a token, the file has none.
    expect(contents).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz')
    expect(contents).toContain('GITHUB_TOKEN=')

    expect(statSync(join(teeDir, logs[0] as string)).mode & 0o777).toBe(0o600)
  })
})

/**
 * Streaming the agent's own output (Issue #447, O5). The cause is
 * vendor-agnostic — the child is spawned on pipes, sees no TTY, and every
 * vendor falls back to a buffered mode that prints nothing until exit — so
 * these cover the rendering contract each vendor plugs into, plus the two
 * parsers that had to learn to read a stream's terminal event instead of one
 * whole blob.
 */
describe('dispatch streaming output (#447 O5)', () => {
  it('renders an assistant turn as the text a human reads', () => {
    const line = renderClaudeEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '  Reading the brief.  ' }] }
    })
    expect(line).toBe('Reading the brief.')
  })

  it('renders a tool call with the one field naming what it acted on', () => {
    expect(
      renderClaudeEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] }
      })
    ).toBe('⚙ Edit: src/a.ts')
    expect(
      renderClaudeEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] }
      })
    ).toBe('⚙ Bash: bun test')
  })

  it('never renders a tool result, which is bulk already captured verbatim in the tee', () => {
    const line = renderClaudeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(50_000) }] }
    })
    expect(line).toBeNull()
  })

  it('truncates a very long subject rather than flooding the terminal', () => {
    const long = `src/${'a'.repeat(400)}.ts`
    const line = renderClaudeEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: long } }] }
    }) as string
    expect(line.length).toBeLessThan(140)
    expect(line.endsWith('...')).toBe(true)
  })

  it('renders nothing for an event that carries nothing worth showing', () => {
    expect(renderClaudeEvent({ type: 'rate_limit_event', rate_limit_info: {} })).toBeNull()
    expect(renderClaudeEvent({ type: 'system', subtype: 'hook_started' })).toBeNull()
    expect(renderGeminiEvent({ type: 'rate_limit', anything: true })).toBeNull()
  })

  it("renders gemini's own stream, whose shape was verified against a real run", () => {
    // `init` / `message` / `result` — the three event kinds a real
    // `gemini --output-format stream-json` run emits, checked rather than
    // assumed (the Issue's trap named exactly this).
    expect(renderGeminiEvent({ type: 'init', session_id: 'x' })).toBe('⏵ session started')
    expect(renderGeminiEvent({ type: 'message', role: 'assistant', content: '  ok  ' })).toBe('ok')
    expect(renderGeminiEvent({ type: 'result', status: 'success' })).toBe('⏹ success')
    // A user echo is the prompt coming back, not the agent working.
    expect(renderGeminiEvent({ type: 'message', role: 'user', content: 'the prompt' })).toBeNull()
  })

  it("reads gemini's usage from its terminal result event, where it previously read none at all", () => {
    const stream = [
      JSON.stringify({ type: 'init' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'ok' }),
      JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 8983, output_tokens: 36 } })
    ].join('\n')
    expect(parseGeminiUsage(stream)).toEqual({ input: 8983, output: 36 })
    expect(parseGeminiUsage('not json')).toBeNull()
  })

  it("reads usage from a stream's terminal event, and still from a single whole-blob payload", () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 22 } })
    ].join('\n')
    expect(parseClaudeUsage(stream)).toEqual({ input: 11, output: 22 })
    // The pre-streaming form is one line, so it must keep working — the
    // change reads both rather than trading one for the other.
    expect(parseClaudeUsage(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }))).toEqual({
      input: 3,
      output: 4
    })
    expect(parseClaudeUsage('not json at all')).toBeNull()
  })

  it("reads claude's genuine model receipt from modelUsage's own key, distinct from the requested alias (O2, #456)", () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 22 },
        modelUsage: { 'claude-sonnet-5': { canonicalModel: 'claude-sonnet-5' } }
      })
    ].join('\n')
    expect(parseClaudeModel(stream)).toBe('claude-sonnet-5')
    // No `modelUsage` field at all — no receipt to read.
    expect(parseClaudeModel(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }))).toBeNull()
    expect(parseClaudeModel('not json at all')).toBeNull()
  })

  it("reads gemini's genuine model receipt from stats.models' own key(s), distinct from the requested alias (O2, #456)", () => {
    const stream = [
      JSON.stringify({ type: 'init' }),
      JSON.stringify({
        type: 'result',
        status: 'success',
        stats: { input_tokens: 8983, output_tokens: 36, models: { 'gemini-3.8-flash': { tokens: {} } } }
      })
    ].join('\n')
    expect(parseGeminiModel(stream)).toBe('gemini-3.8-flash')
    // More than one model key in one run — both are real, join rather than
    // guessing which one to keep.
    const multiModel = JSON.stringify({ stats: { models: { 'gemini-a': {}, 'gemini-b': {} } } })
    expect(parseGeminiModel(multiModel)).toBe('gemini-a,gemini-b')
    // No `models` key at all — no receipt to read.
    expect(parseGeminiModel(JSON.stringify({ stats: { input_tokens: 1, output_tokens: 1 } }))).toBeNull()
    expect(parseGeminiModel('not json')).toBeNull()
  })

  it("reads the resume id from a stream's terminal event, and still from a whole-blob payload", () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'early-and-ignored' }),
      JSON.stringify({ stop_reason: 'end_turn', session_id: 'the-real-one' })
    ].join('\n')
    expect(parseClaudeResumeId(stream)).toBe('the-real-one')
    expect(parseClaudeResumeId(JSON.stringify({ session_id: 'single-blob' }))).toBe('single-blob')
    expect(parseClaudeResumeId('')).toBeNull()
  })
})

/**
 * O1/O2/O4 (Issue #456). A caller-named model reaches the chosen vendor
 * through that vendor's own `--model` flag, the log records the model
 * rather than the vendor, and a model shaped for a different vendor is
 * refused before any spawn.
 */
describe('dispatchRole — model selection (O1/O2/O4, #456)', () => {
  const MODEL_ARGV_FIXTURES: Array<{ agent: 'claude' | 'codex' | 'gemini'; model: string; argv: string[] }> = [
    {
      agent: 'claude',
      model: 'opus',
      argv: ['-p', '--verbose', '--output-format', 'stream-json', '--model', 'opus']
    },
    {
      agent: 'codex',
      model: 'gpt-5.6-sol',
      argv: ['exec', '--model', 'gpt-5.6-sol', '--json', '-']
    },
    {
      agent: 'gemini',
      model: 'gemini-3.5-flash',
      argv: ['-p', '', '--model', 'gemini-3.5-flash', '--output-format', 'stream-json', '--skip-trust']
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
      expect(readArgv(argvOut)).toEqual(fixture.argv)
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
    expect(readArgv(argvOut)).toEqual(['-p', '--verbose', '--output-format', 'stream-json'])
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

  it('O4: a Claude-shaped model passed to codex is refused before any spawn, naming the vendor and the mismatch', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    // A binary that would prove it was spawned if it ever ran.
    const spawnedMarker = join(cwd, 'spawned')
    writeFakeBinary(binDir, 'codex', `#!/bin/sh\ntouch "${spawnedMarker}"\ncat > /dev/null\necho '{}'\nexit 0\n`)

    const r = spawnSync(
      'bun',
      [INDEX, 'dispatch', 'developer', '--agent', 'codex', '--prompt-file', promptFile, '--model', 'claude-opus-5'],
      { encoding: 'utf8', cwd, env: { ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` } }
    )
    expect(r.status).toBe(1)
    expect(existsSync(spawnedMarker)).toBe(false)
    expect(r.stderr).toContain('claude')
    expect(r.stderr).toContain('codex does not accept it')

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect(lines[0]?.event).toBe('dispatch_failed')
    expect((lines[0] as { reason: string }).reason).toBe('refused')
    expect((lines[0] as { model: string }).model).toBe('requested:claude-opus-5')
  })

  it('O4: a Gemini-shaped model passed to claude is refused the same way', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const spawnedMarker = join(cwd, 'spawned')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ntouch "${spawnedMarker}"\ncat > /dev/null\necho '{}'\nexit 0\n`)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--model', 'gemini-3.5-flash'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)
    expect(existsSync(spawnedMarker)).toBe(false)
  })

  it('a same-vendor model, and a vendor with no known naming convention (codex), are never refused for their shape', () => {
    expect(identifyVendorFromModelShape('claude-sonnet-5')).toBe('claude')
    expect(identifyVendorFromModelShape('sonnet')).toBe('claude')
    expect(identifyVendorFromModelShape('gemini-3.5-flash')).toBe('gemini')
    expect(identifyVendorFromModelShape('gemma-3-27b')).toBe('gemini')
    // Codex publishes no naming convention to detect — never treated as a
    // shape, only as a vendor a wrongly-shaped model can be refused FROM.
    expect(identifyVendorFromModelShape('gpt-5.6-sol')).toBeNull()
    expect(identifyVendorFromModelShape('o3')).toBeNull()
    expect(identifyVendorFromModelShape('some-random-string')).toBeNull()
  })

  it('O3: class resolution is a verified, non-stale table for Claude, and deliberately empty for Codex/Gemini', () => {
    expect(resolveClassModel('claude', 'high')).toBe('opus')
    expect(resolveClassModel('claude', 'mid')).toBe('sonnet')
    expect(resolveClassModel('claude', 'fast')).toBe('haiku')
    // No non-stale alias layer exists for either vendor (verified against
    // each CLI's own --help, see `VendorSpec`'s doc comment) — never a
    // guessed, version-pinned model name.
    expect(resolveClassModel('codex', 'high')).toBeNull()
    expect(resolveClassModel('gemini', 'high')).toBeNull()
  })
})
