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
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function runDispatch(args: string[], cwd: string, home: string, path: string): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, 'dispatch', ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, PATH: path }
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
    expect((outcome as { model: string }).model).toBe('claude')
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
    resumeArgv: (id) => ['-p', '-r', id, '--output-format', 'json']
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
    resumeArgv: (id) => ['-p', '', '--resume', id, '--output-format', 'json', '--skip-trust']
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
