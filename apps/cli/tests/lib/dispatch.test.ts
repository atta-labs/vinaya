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

import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
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
  timeoutWarningLeadMs,
  colourAgentLine,
  colourEnabled,
  colourLoopLine,
  recoverUsageFromDispatchTee,
  sawVendorConnectionRetry,
  unreadDocumentationSources,
  getProcessSnapshot,
  matchesCapturedIdentity,
  buildRolePermissions,
  buildWriteAccessScope,
  addCodexWritableDirs,
  PERMISSION_POLICY_VERSION,
  type DispatchTeeRecoveryDeps
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

/**
 * O1 (Issue #670) — every fixture below that starts a role spawns its fake
 * vendor as a GRANDCHILD of a throwaway subprocess script
 * (`runDispatch`/`runScriptWithBudget`/`spawnBudgeted`), never a direct
 * child of this test process: the outer subprocess's own budget kill
 * reaches only that immediate script, never the vendor it spawned, which
 * reparents to the service manager once the script dies or exits normally
 * without terminating its own long-lived child first. `dispatchRole`'s own
 * launch record (`childPid`, written to disk the instant `spawn()` returns —
 * `dispatch.ts`) is the one identity that survives the script's own death,
 * so recursively scanning every launch record under a fixture's own `home`
 * is what lets teardown find a vendor pid it never held any in-memory
 * handle to. Every `.json` file is tried — not just the ones this task
 * happens to know the shape of — so this stays correct if the runtime
 * directory layout under `home` ever changes.
 */
type LaunchedChild = { pid: number; childStartedAt: string | null; childCommand: string | null }

function collectLaunchedChildren(dir: string): LaunchedChild[] {
  const children: LaunchedChild[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return children
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      children.push(...collectLaunchedChildren(full))
      continue
    }
    if (!entry.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as {
        childPid?: unknown
        childStartedAt?: unknown
        childCommand?: unknown
      }
      if (typeof parsed.childPid === 'number') {
        children.push({
          pid: parsed.childPid,
          childStartedAt: typeof parsed.childStartedAt === 'string' ? parsed.childStartedAt : null,
          childCommand: typeof parsed.childCommand === 'string' ? parsed.childCommand : null
        })
      }
    } catch {
      // not a launch record (or a torn write) — never a reason to skip the rest
    }
  }
  return children
}

/**
 * Kills a launch record's own vendor pid AND its process group,
 * unconditionally — the group kill (`-pid`) is a no-op (`ESRCH`) whenever
 * the vendor was never a group leader itself, and the real cleanup on any
 * path where it was. Same idiom `worker-boundary.test.ts`'s
 * `spawnConfinedSync` already established for a confined child: guard on
 * `pid > 0` first (`spawnSync`'s own `0` "never spawned" sentinel would
 * otherwise make `-pid` target THIS process's own group).
 *
 * Round 2 security review, MEDIUM (Issue #670) — never signals a pid whose
 * recorded identity no longer matches a FRESH re-read of that same pid: this
 * host is demonstrably shared with other real processes in one pid
 * namespace, and a fake vendor that already exited earlier in its own test
 * (the timeout-ceiling and shutdown-termination fixtures below all kill it
 * mid-test) leaves a stale `childPid` on disk until this teardown runs —
 * long enough, on a busy host, for the OS to recycle that exact number for
 * an unrelated process. `getProcessSnapshot`/`matchesCapturedIdentity` are
 * the SAME identity guard `dispatch.ts`'s own `terminateLaunchedChildOnShutdown`
 * already applies (that function's own round 4 security HIGH) — reused
 * here rather than reimplemented, so a recycled pid is refused identically
 * on both paths. A pid already gone (`getProcessSnapshot` returns `null`)
 * needs no signal at all.
 */
function killLaunchedChild(child: LaunchedChild): void {
  if (child.pid <= 0) return
  const live = getProcessSnapshot(child.pid)
  if (live === null) return
  if (!matchesCapturedIdentity({ childStartedAt: child.childStartedAt, childCommand: child.childCommand }, live)) return
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch {
    // ESRCH — already gone.
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // ESRCH — never its own group leader, or already gone.
  }
}

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
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type CliResult = { status: number; stdout: string; stderr: string }

/**
 * Round 2 review, MAJOR (Issue #660, O3) — this process's OWN environment,
 * when it is itself a dispatched Developer/Reviewer session, carries
 * `VINAYA_RUNTIME_DIR` (checked before `$HOME` by `resolveRuntimeDirUncached`).
 * Spreading `...process.env` into a fixture's real subprocess hands it THIS
 * machine's real, shared runtime directory regardless of the fixture's own
 * isolated `$HOME` — the same leak already fixed in `dev-review-loop.test.ts`,
 * `dispatch/reconcile-launch.test.ts` and `task-tools/cancel.test.ts`. One
 * call site here already stripped `VINAYA_RUN_ID` alone (found live, for a
 * narrower reason — see its own comment below); that was never enough.
 */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  return out
}

/**
 * Generous on a quiet host and below `bun:test`'s own default per-test
 * timeout, so a genuinely stuck subprocess (lock contention on a path
 * another fixture or another concurrent task run still holds) is caught
 * HERE, with the child's own captured output, before a bare framework
 * timeout can kill the run with no diagnostic at all.
 */
const DISPATCH_SUBPROCESS_BUDGET_MS = 18_000

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
      // `extraEnv` merges AFTER the strip, never before it: a caller that
      // deliberately passes its own `VINAYA_RUN_ID` (the doc-gate fixture
      // below does, to pin the sources-file name it later reads back) must
      // survive — only the AMBIENT, inherited `VINAYA_*` this outer test
      // process itself carries gets stripped.
      env: { ...stripVinayaEnv(process.env), HOME: home, PATH: path, ...extraEnv },
      timeout: DISPATCH_SUBPROCESS_BUDGET_MS,
      killSignal: 'SIGKILL'
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string | null }
    if (err.signal) {
      throw new Error(
        `vinaya dispatch subprocess killed by ${err.signal} after exceeding its ${DISPATCH_SUBPROCESS_BUDGET_MS}ms budget ` +
          `(args: ${args.join(' ')})\n--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
      )
    }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/**
 * The shared shape several fixtures below use for a one-off `bun <script>`
 * subprocess (never through `runDispatch`/the CLI's own `dispatch`
 * subcommand): bounded by the same budget, and surfacing the child's own
 * captured output on expiry rather than a bare timeout.
 */
function runScriptWithBudget(script: string, cwd: string, env: NodeJS.ProcessEnv): void {
  try {
    execFileSync('bun', [script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: DISPATCH_SUBPROCESS_BUDGET_MS,
      killSignal: 'SIGKILL'
    })
  } catch (e) {
    const err = e as { signal?: string | null; stdout?: unknown; stderr?: unknown }
    if (err.signal) {
      throw new Error(
        `fixture script killed by ${err.signal} after exceeding its ${DISPATCH_SUBPROCESS_BUDGET_MS}ms budget ` +
          `(script: ${script})\n--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
      )
    }
    throw e
  }
}

/**
 * Issue #660, O3 round 5 (reviewer BLOCKER F1 / security HIGH F1) — every
 * remaining direct `spawnSync` call below bypasses `runDispatch`/
 * `runScriptWithBudget` for a return-shape reason each call site's own
 * comment explains (raw `stderr`, a raw `SpawnSyncReturns` a test reads
 * `.status`/`.signal` off directly, or a `bun <script>` invocation that
 * isn't the `dispatch` subcommand at all). Several of those direct calls
 * carried a `timeout` with no `killSignal` and no signal-checked diagnostic
 * throw; the hook-script call sites carried no budget at all. This wraps
 * every one of them in the identical budget-plus-diagnostic discipline
 * those two helpers already apply, without changing any call site's own
 * return shape — `r.status`/`r.stdout`/`r.stderr` still read exactly as
 * before; only a genuine budget-exceeded kill now throws instead of
 * returning a bare, undiagnosable non-zero/timed-out result.
 */
function spawnBudgeted(
  args: string[],
  opts: SpawnSyncOptionsWithStringEncoding,
  label: string
): SpawnSyncReturns<string> {
  const r = spawnSync('bun', args, { ...opts, timeout: DISPATCH_SUBPROCESS_BUDGET_MS, killSignal: 'SIGKILL' })
  if (r.signal) {
    throw new Error(
      `${label} subprocess killed by ${r.signal} after exceeding its ${DISPATCH_SUBPROCESS_BUDGET_MS}ms budget\n` +
        `--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`
    )
  }
  return r
}

function writeFakeBinary(dir: string, name: string, script: string): string {
  const p = join(dir, name)
  writeFileSync(p, script)
  chmodSync(p, 0o755)
  return p
}

/**
 * A fake vendor binary that stays identity-stable — `comm` and start time
 * unchanged from `spawn()` all the way through termination — the way a real
 * installed vendor CLI does (one shebang-triggered exec, never a second
 * one). `#!/bin/sh … exec sleep 30` used to serve the O1 shutdown tests'
 * need for a clean, signal-killable leaf process, but its own TWO exec
 * transitions (`/bin/sh` then `sleep`) raced the identity capture O3 added:
 * `childCommand`, snapshotted the instant `spawn()` returns, could still
 * read the pre-exec `sh` name if that second `exec` hadn't run yet by the
 * time a later re-check ran — a real, found-live flake on a slower/loaded
 * CI runner (`Test (apps/cli, shard 2)`), never reproduced locally where
 * both reads happened to land on the same side of the race. Shebang-ing
 * DIRECTLY at the real `bun` binary (`process.execPath` — never `/usr/bin/env
 * bun`, which is itself a second exec hop with the identical race) gives a
 * single, stable process image throughout, so identity capture and every
 * later re-check always agree.
 *
 * O3 (Issue #670) — bounded to 30s rather than an unbounded wait: every
 * caller of this fixture kills it (or lets it be killed) well inside that
 * window, but a teardown that never runs for whatever reason still cannot
 * leave this process burning a core for hours, the way an unbounded
 * `await new Promise(() => {})` alone did. Same magnitude as this file's own
 * `sleep 30` fixtures below (the SIGTERM/SIGKILL grace-window tests) —
 * comfortably above every real budget in this file (18s subprocess budget,
 * 10s per-test timeouts) and comfortably below "hours."
 */
function writeIdentityStableFakeBinary(dir: string, name: string): string {
  return writeFakeBinary(
    dir,
    name,
    `#!${process.execPath}\nprocess.stdin.resume()\nsetTimeout(() => process.exit(0), 30000)\nawait new Promise(() => {})\n`
  )
}

function outboxLines(home: string, issue: number | 'none'): unknown[] {
  // [task-files-v1] 5, O1: the default `logs` destination is now a folder
  // under this repository's own `runtimeDir` — never the machine-global
  // `~/.vinaya/outbox/` these fixtures resolve to `unresolved` (no git
  // origin in the scratch `cwd`).
  const p = join(home, '.vinaya', 'runtime', 'unresolved', 'logs', 'unresolved', `${issue}.ndjson`)
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
    // trailing `flushOutbox` call (task 3, `#482`, O1) refuses locally —
    // safely, before any network call (confirmed live: `gh issue comment`
    // outside a git repo fails on repo resolution alone). That refusal is
    // deliberate here — a SUCCEEDING flush would truncate the very outbox
    // lines this test reads below — but never reaches this process's own
    // exit code any more: `flushOutbox` never calls `process.exit`, and
    // `dispatchCommand` catches its thrown `LogFlushError` and logs it to
    // stderr, non-fatally, exactly as its own doc comment promises. `--task`'s
    // effect on env attribution and the log lines themselves is this test's
    // concern, not the flush (see `apps/cli/tests/commands/dispatch.test.ts`
    // for that).
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9001'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

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

  it('Codex gives a normal stdin/JSONL dispatch workspace-write access', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    const stdinOut = join(cwd, 'stdin.out')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeFakeBinary(
      binDir,
      'codex',
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argvOut}"\ncat > "${stdinOut}"\nprintf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'\n`
    )

    const r = runDispatch(
      ['developer', '--agent', 'codex', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )

    expect(r.status).toBe(0)
    expect(readArgv(argvOut)).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--strict-config',
      '--dangerously-bypass-hook-trust',
      '--skip-git-repo-check',
      '--json',
      '-'
    ])
    expect(readFileSync(stdinOut, 'utf8')).toBe(PROMPT_FILE_CONTENT)
  })
})

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

  it('does not pass unsupported --add-dir flags to codex exec resume', () => {
    const dir = tempDir('vinaya-codex-write-resume-')
    const argv = ['exec', 'resume', 'thread-id', '--json', '-']
    expect(addCodexWritableDirs(argv, [dir], true)).toEqual(argv)
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
    // The `dispatch_failed` log event's own `reason` field is validated
    // against `@attalabs/aeg-core`'s schema (out of this task's surface) and
    // keeps reporting the real event class unchanged — `DispatchHandle`'s
    // own, CLI-local `failureReason` is where the finer `'unbound'`
    // distinction lives (Issue #636, O5; see the describe block below).
    expect((failed as { reason: string }).reason).toBe('crash')
  })
})

describe("dispatchRole — Issue #636, O5: a child that exits without ever binding a session is named 'unbound', not 'crash'/'timeout'", () => {
  it('a non-zero exit with no session ever reported returns failureReason "unbound", and says so on stderr', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    // Never prints a `session_id`-bearing line at all — the exact
    // "sandbox-exec whose vendor output stayed at 0 bytes" shape the brief's
    // motivating incident measured.
    writeFakeBinary(binDir, 'claude', '#!/bin/sh\ncat > /dev/null\nexit 7\n')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('unbound')
    expect(r.stderr).toMatch(/without ever producing a working vendor session — failing now as 'unbound'/)
  })

  it('a crash AFTER the vendor bound a session still reports failureReason "crash", never "unbound"', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"bound-session-1"}'\nexit 7\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('crash')
  })
})

describe("dispatchRole — [task-operator-v1]/Issue #662, O2: a child that could not reach the vendor's backend is named 'connection-failed'", () => {
  it("a non-zero exit after a bound session AND a confirmed-live api_retry marker reports failureReason 'connection-failed', never 'crash'", () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    // The exact shape confirmed live against claude CLI 2.1.197 with
    // ANTHROPIC_BASE_URL pointed at an unreachable host — a bound session,
    // one or more api_retry lines, then the process gives up non-zero.
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh
cat > /dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"bound-session-1"}'
printf '%s\\n' '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":null,"error":"unknown","session_id":"bound-session-1"}'
exit 7
`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('connection-failed')
  })

  it('a non-zero exit with an api_retry marker but NO bound session still reports "unbound" — there is no exact session to resume', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh
cat > /dev/null
printf '%s\\n' '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":null,"error":"unknown","session_id":null}'
exit 7
`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('unbound')
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
    // A refused attempt now also logs its own
    // `role_attempt`/`usage` lines alongside the pre-existing
    // `dispatch_failed` — three lines, one per family, for one attempt.
    // `log()` writes each asynchronously (`log-sink.ts`'s own
    // `resolveRepo().then(...)`), so the three calls' lines can land in
    // either order — never asserted on position.
    expect(lines).toHaveLength(3)
    const dispatchLine = lines.find((l) => l.kind === 'dispatch')
    expect(dispatchLine?.event).toBe('dispatch_failed')
    expect((dispatchLine as { reason: string }).reason).toBe('refused')
    expect(lines.find((l) => l.kind === 'role_attempt')).toMatchObject({ outcome: 'capability_refused' })
    expect(lines.find((l) => l.kind === 'usage')).toMatchObject({ units: { input: null, output: null, cache: null } })
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
    expect(lines).toHaveLength(3)
    const dispatchLine = lines.find((l) => l.kind === 'dispatch')
    expect((dispatchLine as { reason: string }).reason).toBe('refused')
    expect(lines.find((l) => l.kind === 'role_attempt')).toMatchObject({ outcome: 'capability_refused' })
  })
})

describe('dispatchRole — timeout ceiling', () => {
  it('SIGTERMs a child that ignores it, then SIGKILLs after the grace window, and the pid is actually gone', () => {
    // `killGraceMs` (task-run-v1 20, O2): the escalation this test proves —
    // SIGTERM ignored, SIGKILL follows once the grace window elapses — does
    // not need the real 5000ms production default to be observed, only a
    // real, non-zero window the child can be caught inside. Configuring it
    // down to 200ms cuts this test's real wall time by ~4.8s without
    // faking any of the process signalling it exercises.
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
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500, killGraceMs: 200 } }))
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
  }, 10_000)

  it('reports timeout even when the child exits cleanly on SIGTERM alone (no SIGKILL needed)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null &\ntrap 'exit 0' TERM\nsleep 30\n`)
    // Same startup-latency reasoning as the test above: the shell needs
    // real wall time, under this file's own subprocess contention, to
    // reach its own `trap` before `SIGTERM` arrives. killGraceMs: 200 (same
    // reasoning as the escalation test above) — the child exits cleanly on
    // SIGTERM alone here, so the grace window is never actually consumed
    // by a SIGKILL, but a small one still keeps this test from paying the
    // production default while the parent's own escalation timer is armed.
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500, killGraceMs: 200 } }))
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
      `#!/bin/sh\necho '{"usage":{"input_tokens":184327,"output_tokens":22190,"cache_read_input_tokens":500}}'\ntrap '' TERM\ncat > /dev/null &\nsleep 30\n`
    )
    // killGraceMs: 200 — same reasoning as the escalation test above; this
    // test's own concern (usage survives the kill) needs only that a
    // SIGKILL eventually happens, not the production-sized window before it.
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500, killGraceMs: 200 } }))
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

    // The richer `usage` family event survives the
    // kill exactly the same way — including the cache breakout the
    // pre-existing `dispatch` family's own usage field has no room for.
    const usageEvent = lines.find((l) => l.kind === 'usage') as
      | { units: { input: number | null; output: number | null; cache: number | null }; unknown_reason: string | null }
      | undefined
    expect(usageEvent?.units).toEqual({ input: 184327, output: 22190, cache: 500 })
    expect(usageEvent?.unknown_reason).toBeNull()
    expect(lines.find((l) => l.kind === 'role_attempt')).toMatchObject({ outcome: 'timed_out' })
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

    // Strip an inherited `VINAYA_RUN_ID`: this test's own process can
    // itself be running inside a `vinaya dispatch` call (a nested dev-loop
    // invocation, or — found live — this very test suite run from inside
    // an agent session that `vinaya dispatch developer` started), which
    // sets `VINAYA_RUN_ID` in ITS OWN env for its own bookkeeping. Spreading
    // `...process.env` unfiltered would leak that value into the spawned
    // script, and `createLogSink`'s `VINAYA_RUN_ID || randomUUID()` would
    // then have both calls inherit the SAME id instead of minting two
    // distinct ones — collapsing the exact invariant this test exists to
    // prove, for a reason that has nothing to do with `dispatchRole` itself.
    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })

    runScriptWithBudget(script, cwd, spawnEnv)

    // Each call's own `dispatched`/`role_attempt`/`usage`/`outcome_received`
    // quartet (added alongside dispatched/outcome_received) legitimately shares
    // ONE run_id (one `createLogSink()` call per `dispatchRole` invocation)
    // — the invariant under test is exactly two DISTINCT run_ids (one per
    // call), not that every line's run_id is unique.
    const lines = outboxLines(home, 'none') as Array<{ meta: { run_id: string } }>
    expect(lines.length).toBe(8)
    const runIds = new Set(lines.map((l) => l.meta.run_id))
    expect(runIds.size).toBe(2)
  })
})

describe("dispatchRole — child identity settles across the vendor's own exec hop (O3, Issue #605, code review)", () => {
  it('records the SETTLED process identity, not the shebang launcher it started as', () => {
    // A real npm-installed vendor CLI shebangs `#!/usr/bin/env node`: the
    // kernel's own shebang-triggered exec lands on `env`, and `env` THEN
    // performs its own, second, user-space exec into `node` — the same
    // process, but a different `comm`, landing some time after `spawn()`
    // already returned. Modeled here with a `/bin/sh` launcher that sleeps
    // briefly before `exec`-ing into the identity-stable leaf binary, so a
    // read taken the instant `spawn()` returns is guaranteed to still see
    // `sh`, not the process that survives.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const finalBinary = writeIdentityStableFakeBinary(binDir, 'claude-final')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\nsleep 0.3\nexec "${finalBinary}"\n`)

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
    const script = join(cwd, 'settle-identity.ts')
    const resultPath = join(cwd, 'result.json')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { execFileSync } from 'node:child_process'`,
        `import { dispatchRole, readLaunchRecord } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 43 }`,
        // Fire-and-forget, exactly as the shutdown tests above do: the
        // child never exits on its own (`await new Promise(() => {})`).
        `void dispatchRole('developer', 'claude', 'p', opts)`,
        'async function waitForChildCommand(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('developer', 'claude', null, 43)`,
        `    if (parsed.status === 'ok' && parsed.record.childCommand !== null) return parsed.record`,
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childCommand')`,
        '}',
        'const record = await waitForChildCommand(5000)',
        // Ground truth, via a FRESH `ps` read on the child's own pid, taken
        // well after the shell's own 0.3s exec hop has certainly landed —
        // never the same read `captureSettledChildSnapshot` itself took.
        `const groundTruth = execFileSync('ps', ['-p', String(record.childPid), '-o', 'comm='], { encoding: 'utf8' }).trim()`,
        `execFileSync('kill', ['-TERM', String(record.childPid)])`,
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ childCommand: record.childCommand, groundTruth }))`,
        'process.exit(0)'
      ].join('\n')
    )

    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { childCommand: string | null; groundTruth: string }
    // The launcher's own identity ('sh') must never be what gets recorded.
    expect(result.childCommand).not.toBe('sh')
    expect(result.childCommand).not.toBeNull()
    // The recorded identity must match the SETTLED process, confirmed by an
    // independent, later `ps` read on the same pid.
    expect(result.childCommand).toBe(result.groundTruth)
  }, 10_000)
})

describe('terminateLaunchedChildOnShutdown — driver shutdown termination (O1, Issue #605)', () => {
  it("terminates the dispatched child and marks the launch record 'interrupted', leaving no orphan", () => {
    // Exercises `terminateLaunchedChildOnShutdown` directly, the way
    // `dev-review-loop.ts`'s own SIGTERM/SIGINT handler calls it — from a
    // dedicated script subprocess (the "two dispatches" pattern above),
    // never by importing `dispatch.ts` into THIS test process (whose
    // `GLOBAL_VINAYA_HOME` is frozen at first import from the real `HOME`).
    // A real OS signal is never sent to this test's own process here:
    // `dev-review-loop.ts`'s handler wiring is a thin, one-line call into
    // this exact function, so what needs proving is the function's own
    // behavior, not Node's signal-delivery machinery.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    // Identity-stable (round 5, CI flake fix — see the helper's own doc
    // comment) and, like `sleep`, terminates on a plain `SIGTERM` with no
    // grandchild left behind to reparent.
    writeIdentityStableFakeBinary(binDir, 'claude')

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
    const script = join(cwd, 'shutdown-terminate.ts')
    const resultPath = join(cwd, 'result.json')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { execFileSync } from 'node:child_process'`,
        `import { dispatchRole, readLaunchRecord, terminateLaunchedChildOnShutdown } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 42 }`,
        // Fire-and-forget: this promise settles only once the child exits,
        // which (absent our own termination below) would not happen until
        // its own 30s sleep — never awaited here.
        `void dispatchRole('developer', 'claude', 'p', opts)`,
        'async function waitForChildPid(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('developer', 'claude', null, 42)`,
        `    if (parsed.status === 'ok' && parsed.record.childPid !== null) return`,
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childPid')`,
        '}',
        'await waitForChildPid(5000)',
        `const before = readLaunchRecord('developer', 'claude', null, 42)`,
        `const childPid = before.status === 'ok' ? before.record.childPid : null`,
        // The call under test — synchronous, and (like the real SIGTERM
        // handler) never yielding to the event loop before the process
        // below reads the record back and exits.
        `terminateLaunchedChildOnShutdown('developer', 'claude', null, 42)`,
        `const after = readLaunchRecord('developer', 'claude', null, 42)`,
        // Real OS ground truth, via a fresh `ps` invocation — never
        // `process.kill(childPid, 0)` from THIS SAME process, which still
        // holds `dispatchRole`'s own (never-awaited, never-reaped)
        // `ChildProcess` handle open on `childPid`: that keeps reporting the
        // pid "alive" by this process's own bookkeeping for a beat after the
        // kernel has already reaped it, a same-process artifact with no
        // bearing on whether an orphan actually persists on the system.
        //
        // O4: reads the STAT column, not just whether the pid still has a
        // `ps` entry at all. Bun 1.2.14's synchronous `ps -p` call ran while
        // its own spin gave this fire-and-forget child's internal SIGCHLD
        // handling a chance to run first, so the entry was usually already
        // gone by the time this check ran. On Bun 1.4.2 that spin is gone,
        // so `ps -p` can find the child still present as a genuine kernel
        // zombie (`Z`) — terminated, exited, but not yet reaped by this
        // process's own never-awaited `ChildProcess` handle. A zombie is
        // dead, not an orphan; only a real, still-running state (anything
        // else `ps` reports) counts as still alive.
        'let childAlive = false',
        'if (childPid !== null) {',
        `  try { const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); childAlive = stat.length > 0 && !stat.startsWith('Z') } catch { childAlive = false }`,
        '}',
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after, childAlive }))`,
        'process.exit(0)'
      ].join('\n')
    )

    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      before: { status: string; record: { status: string; childPid: number } }
      after: { status: string; record: { status: string; failureReason: string | null; finishedAt: string | null } }
      childAlive: boolean
    }
    expect(result.before.record.status).toBe('launched')
    // O1: no orphan left behind.
    expect(result.childAlive).toBe(false)
    // O1: no stale `'launched'` record for the next start to misread as live.
    expect(result.after.record.status).toBe('interrupted')
    expect(result.after.record.failureReason).toBe('signal')
    expect(result.after.record.finishedAt).not.toBeNull()
  }, 10_000)

  it('round 4 security review, HIGH: never signals a pid whose recorded identity no longer matches — a stale record naming a recycled pid is left untouched', () => {
    // Simulates the exact scenario the finding named: the on-disk record
    // still names a real, live pid (our own spawned child, standing in for
    // "the OS has since recycled this number"), but its captured identity
    // (`childStartedAt`) no longer matches — exactly what recovery's own
    // `classifyChildLiveness` already refuses to treat as a match.
    // `terminateLaunchedChildOnShutdown` must refuse identically: no signal
    // sent, the child left running, the record still patched to
    // `'interrupted'` (there is nothing of THIS launch's own left to
    // terminate, accounted for all the same).
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeIdentityStableFakeBinary(binDir, 'claude')

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
    const script = join(cwd, 'shutdown-terminate-identity-mismatch.ts')
    const resultPath = join(cwd, 'result-identity-mismatch.json')
    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      '42',
      'sessions',
      'developer-claude.json'
    )
    writeFileSync(
      script,
      [
        `import { writeFileSync, readFileSync } from 'node:fs'`,
        `import { execFileSync } from 'node:child_process'`,
        `import { dispatchRole, readLaunchRecord, terminateLaunchedChildOnShutdown } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 42 }`,
        `void dispatchRole('developer', 'claude', 'p', opts)`,
        'async function waitForChildPid(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('developer', 'claude', null, 42)`,
        `    if (parsed.status === 'ok' && parsed.record.childPid !== null) return`,
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childPid')`,
        '}',
        'await waitForChildPid(5000)',
        // Corrupt the record's own captured identity in place, on disk —
        // the real childPid is untouched (still our real sleeping child),
        // only what the record CLAIMS about it changes, exactly as a stale
        // record from an earlier, differently-identified process would read.
        `const raw = JSON.parse(readFileSync(${JSON.stringify(recordPath)}, 'utf8'))`,
        `raw.childStartedAt = 'Mon Jan 1 00:00:00 2024'`,
        `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(raw, null, 2))`,
        `const before = readLaunchRecord('developer', 'claude', null, 42)`,
        `const childPid = before.status === 'ok' ? before.record.childPid : null`,
        `terminateLaunchedChildOnShutdown('developer', 'claude', null, 42)`,
        `const after = readLaunchRecord('developer', 'claude', null, 42)`,
        // O4: STAT-aware — a kernel zombie is dead, not still alive; see the
        // first shutdown test's own doc comment above for why this changed.
        'let childAlive = false',
        'if (childPid !== null) {',
        `  try { const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); childAlive = stat.length > 0 && !stat.startsWith('Z') } catch { childAlive = false }`,
        '}',
        // Clean up the real child ourselves — the function under test must
        // NOT have done this, which is exactly what this test proves.
        "if (childPid !== null) { try { process.kill(childPid, 'SIGKILL') } catch {} }",
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after, childAlive }))`,
        'process.exit(0)'
      ].join('\n')
    )

    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      before: { record: { status: string; childStartedAt: string } }
      after: { record: { status: string; failureReason: string | null } }
      childAlive: boolean
    }
    expect(result.before.record.childStartedAt).toBe('Mon Jan 1 00:00:00 2024')
    // The real point: identity mismatched, so the real child was NEVER signaled.
    expect(result.childAlive).toBe(true)
    // The record is still accounted for — nothing of THIS launch's own is
    // left in flight, even though the pid it once named turned out not to
    // be a match any more.
    expect(result.after.record.status).toBe('interrupted')
    expect(result.after.record.failureReason).toBe('signal')
  }, 10_000)

  it("round 3 review, MAJOR/HIGH: terminates a REVIEWER's dispatched child too — the driver now calls this for every in-flight role, not developer only", () => {
    // Same mechanism, same proof — `terminateLaunchedChildOnShutdown` takes
    // `role` as a plain parameter with no developer-specific logic inside
    // it; `dev-review-loop.ts`'s own SIGTERM/SIGINT handlers now call it for
    // `'code-reviewer'`/`'security'` too (both dispatched concurrently via
    // `Promise.all`, exactly as capable of being orphaned mid-round as the
    // developer's own launch).
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeIdentityStableFakeBinary(binDir, 'claude')

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
    const script = join(cwd, 'shutdown-terminate-reviewer.ts')
    const resultPath = join(cwd, 'result-reviewer.json')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { execFileSync } from 'node:child_process'`,
        `import { dispatchRole, readLaunchRecord, terminateLaunchedChildOnShutdown } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 42 }`,
        `void dispatchRole('code-reviewer', 'claude', 'p', opts)`,
        'async function waitForChildPid(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('code-reviewer', 'claude', null, 42)`,
        `    if (parsed.status === 'ok' && parsed.record.childPid !== null) return`,
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childPid')`,
        '}',
        'await waitForChildPid(5000)',
        `const before = readLaunchRecord('code-reviewer', 'claude', null, 42)`,
        `const childPid = before.status === 'ok' ? before.record.childPid : null`,
        `terminateLaunchedChildOnShutdown('code-reviewer', 'claude', null, 42)`,
        `const after = readLaunchRecord('code-reviewer', 'claude', null, 42)`,
        // O4: STAT-aware — a kernel zombie is dead, not still alive; see the
        // first shutdown test's own doc comment above for why this changed.
        'let childAlive = false',
        'if (childPid !== null) {',
        `  try { const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); childAlive = stat.length > 0 && !stat.startsWith('Z') } catch { childAlive = false }`,
        '}',
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after, childAlive }))`,
        'process.exit(0)'
      ].join('\n')
    )

    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      before: { record: { status: string } }
      after: { record: { status: string; failureReason: string | null } }
      childAlive: boolean
    }
    expect(result.before.record.status).toBe('launched')
    expect(result.childAlive).toBe(false)
    expect(result.after.record.status).toBe('interrupted')
    expect(result.after.record.failureReason).toBe('signal')
  }, 10_000)

  it("a launch record that already read 'completed' or 'interrupted' is left untouched — nothing left to terminate", () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{}'\nexit 0\n`)

    // A real, already-completed dispatch through the ordinary CLI path.
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '43'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
    const script = join(cwd, 'shutdown-terminate-noop.ts')
    const resultPath = join(cwd, 'result-noop.json')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { readLaunchRecord, terminateLaunchedChildOnShutdown } from ${JSON.stringify(dispatchLib)}`,
        `const before = readLaunchRecord('developer', 'claude', null, 43)`,
        `terminateLaunchedChildOnShutdown('developer', 'claude', null, 43)`,
        `const after = readLaunchRecord('developer', 'claude', null, 43)`,
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after }))`
      ].join('\n')
    )
    runScriptWithBudget(script, cwd, stripVinayaEnv({ ...process.env, HOME: home }))

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      before: { record: { status: string; finishedAt: string } }
      after: { record: { status: string; finishedAt: string } }
    }
    expect(result.before.record.status).toBe('completed')
    // Untouched: same status, same `finishedAt` — never re-patched to `interrupted`.
    expect(result.after.record.status).toBe('completed')
    expect(result.after.record.finishedAt).toBe(result.before.record.finishedAt)
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

    runScriptWithBudget(
      script,
      cwd,
      stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
    )

    const lines = outboxLines(home, 'none') as Array<{
      kind: string
      meta: { run_id: string }
      effect_id?: string
      event: string
      target_role?: string
    }>
    // Two concurrent dispatches, each now a `dispatched`/`role_attempt`/
    // `usage`/`outcome_received` quartet — eight lines.
    expect(lines.length).toBe(8)

    // Both calls really did share one run_id — the scenario under test,
    // not a fixture that accidentally avoided it.
    const runIds = new Set(lines.map((l) => l.meta.run_id))
    expect(runIds).toEqual(new Set(['shared-run-id-fixture']))

    // Despite the shared run_id, every `dispatch`/`role_attempt` line is
    // unambiguously attributable to its own call via effect_id — exactly
    // two distinct effect_ids, each carrying exactly one 'dispatched', one
    // 'attempted', and one 'outcome_received' line, agreeing on which role
    // they belong to (never a 'developer' line and a 'code-reviewer' line
    // sharing one effect_id). `usage` lines carry no `effect_id` at all
    // (`log/schema.ts`'s `usage` family) — excluded from this grouping,
    // never silently bucketed under an `undefined` key.
    const attributable = lines.filter((l) => l.kind !== 'usage')
    const byEffectId = new Map<string, typeof attributable>()
    for (const line of attributable) {
      const group = byEffectId.get(line.effect_id as string) ?? []
      group.push(line)
      byEffectId.set(line.effect_id as string, group)
    }
    expect(byEffectId.size).toBe(2)
    for (const group of byEffectId.values()) {
      expect(group.map((l) => l.event).sort()).toEqual(['attempted', 'dispatched', 'outcome_received'])
    }
    const dispatchLines = lines.filter((l) => l.kind === 'dispatch')
    expect(new Set(dispatchLines.map((l) => l.target_role))).toEqual(new Set(['developer', 'code-reviewer']))
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
    resumeArgv: (id) => [
      'exec',
      'resume',
      id,
      '--strict-config',
      '--dangerously-bypass-hook-trust',
      '--skip-git-repo-check',
      '--json',
      '-'
    ]
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
      // O1 (#543): claude alone gets a trailing `--settings <path>` pair
      // (see the dedicated O1 describe block below) — stripped here so this
      // test keeps asserting the vendor-specific resume shape it always has.
      const actualArgv = readArgv(argvOut)
      if (fixture.agent === 'claude') {
        expect(actualArgv.slice(-2, -1)).toEqual(['--settings'])
        expect(actualArgv.slice(0, -2)).toEqual(fixture.resumeArgv(synthId))
      } else {
        expect(actualArgv).toEqual(fixture.resumeArgv(synthId))
      }
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
    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      '454',
      'sessions',
      'developer-claude.json'
    )

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId1}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    // `--task` makes `dispatchCommand` also try `flushOutbox` with no `gh`
    // on PATH outside a git repo — refused locally, the same deliberate
    // shape the first `dispatchRole` describe block above documents, caught
    // non-fatally so it never reaches this process's own exit code. The
    // resume record is written by `dispatchRole` itself, before that flush
    // step ever runs, so it exists regardless.
    const first = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '454'],
      cwd,
      home,
      path
    )
    expect(first.status).toBe(0)

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
    expect(second.status).toBe(0)

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

    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'sessions',
      'developer-claude.json'
    )
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
      readFileSync(
        join(home, '.vinaya', 'runtime', 'acme-tranche-a', 'tasks-execution', '9', 'sessions', 'developer-claude.json'),
        'utf8'
      )
    ) as { resumeId: string }
    const recordB = JSON.parse(
      readFileSync(
        join(home, '.vinaya', 'runtime', 'acme-tranche-b', 'tasks-execution', '9', 'sessions', 'developer-claude.json'),
        'utf8'
      )
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

    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      '9',
      'sessions',
      'developer-claude.json'
    )
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { resumeId: string }
    expect(record.resumeId).toBe(synthId)
    expect(existsSync(join(home, '.vinaya', 'runtime', 'etc'))).toBe(false)
  })

  it('a crashing child that never reported a session keeps its interrupted intent record, with no session to resume (O1) — named unbound, not crash (Issue #636, O5)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    // Crashes before printing any `session_id` at all — the "failed attempts
    // can lose session identity" defect this task closes: the intent record
    // now PERSISTS (O1, launch intent written before spawn, never deleted on
    // an interrupt), marked `interrupted`, but with `resumeId: null` because
    // the vendor never reported one — the honest "there is genuinely no
    // session to resume" case, distinct from "no launch ever happened."
    //
    // Issue #636, O5: this exact case — exited, never bound a session — is
    // named `'unbound'`, not the generic `'crash'` every other non-zero exit
    // gets, so recovery can tell "the vendor never came up at all" apart from
    // "the vendor did real work, then died."
    writeFakeBinary(binDir, 'claude', '#!/bin/sh\ncat > /dev/null\nexit 7\n')
    const result = runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(result.status).toBe(1)

    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'sessions',
      'developer-claude.json'
    )
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      status: string
      failureReason: string | null
      resumeId: string | null
    }
    expect(record.status).toBe('interrupted')
    expect(record.failureReason).toBe('unbound')
    // No session was ever bound — `readResumeRecord`'s own compat view returns
    // null for exactly this, so the loop still starts fresh rather than
    // resuming a session that never existed.
    expect(record.resumeId).toBeNull()
  })

  it('a crash AFTER the vendor reported its session keeps that session on the interrupted record — session identity survives the interruption (O1)', () => {
    const synthId = '88888888-8888-8888-8888-888888888888'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    // The vendor prints its session id (bound mid-stream), then exits non-zero
    // — before this task an interrupted attempt wrote no record at all and the
    // session was lost; now the bound session survives on the interrupted
    // record so recovery can resume the exact session.
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"${synthId}"}'\nexit 7\n`
    )
    const result = runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(result.status).toBe(1)

    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'sessions',
      'developer-claude.json'
    )
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      status: string
      failureReason: string | null
      resumeId: string | null
    }
    expect(record.status).toBe('interrupted')
    expect(record.failureReason).toBe('crash')
    expect(record.resumeId).toBe(synthId)
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
/**
 * Where `openOutputTee` writes. Read off the tee's own returned path rather
 * than rebuilt here: this block runs IN-PROCESS, so the runtime directory
 * resolves against the real repository this checkout belongs to, and a
 * hardcoded repo segment would bind the test to whatever clone it ran in.
 */
function teeDirOf(path: string): string {
  return dirname(path)
}

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
    // One real tee first, purely to learn where this process's own output
    // directory actually is (it resolves against the real repository this
    // checkout belongs to — see `teeDirOf`).
    const probe = openOutputTee(`test-${randomUUID()}`)
    probe.end()
    const teeDir = teeDirOf(probe.path as string)
    rmSync(probe.path as string, { force: true })

    const before = existsSync(teeDir) ? readdirSync(teeDir) : []
    for (const bad of ['nested/../../escape-attempt', '../escape', 'a/b', '', '.']) {
      const tee = openOutputTee(bad)
      expect(tee.path).toBeNull()
      tee.write(Buffer.from('must not be written'))
      tee.end()
    }
    const after = existsSync(teeDir) ? readdirSync(teeDir) : []
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
    expect(statSync(teeDirOf(tee.path as string)).mode & 0o777).toBe(0o700)
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
    const r = spawnBudgeted(
      [INDEX, 'dispatch', 'developer', '--agent', 'claude', '--prompt-file', promptFile],
      {
        encoding: 'utf8',
        cwd,
        env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
      },
      'vinaya dispatch'
    )
    expect(r.status).toBe(0)

    // The path is announced once, correlated with the run's effect id.
    expect(r.stderr).toContain('output teed to')
    expect(r.stderr).toMatch(/\[vinaya dispatch [0-9a-f-]{36}\]/)

    const teeDir = join(home, '.vinaya', 'runtime', 'unresolved', 'tasks-execution', 'unscoped', 'output')
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

describe('dispatch role log — redaction (round 2 review, SECURITY HIGH)', () => {
  it('never writes a token-shaped string from a rendered agent event to the role log', () => {
    const home = tempDir('vinaya-rolelog-home-')
    const cwd = tempDir('vinaya-rolelog-cwd-')
    const binDir = tempDir('vinaya-rolelog-bin-')
    const roleLogPath = join(cwd, 'role.log')
    // A `stream-json` line whose rendered text is exactly what a dispatched
    // agent's own tool output can echo — a real credential value, not a
    // synthetic marker — the same shape `openOutputTee`'s own redaction test
    // above exercises for the tee, now for `appendRoleLine`'s separate sink.
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz' }]
      }
    })
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '${assistantLine}'\necho '{"usage":{"input_tokens":1,"output_tokens":2}}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--role-log-path', roleLogPath],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const contents = readFileSync(roleLogPath, 'utf8')
    expect(contents).toContain('[developer]')
    expect(contents).toContain('GITHUB_TOKEN=')
    expect(contents).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz')
  })
})

/**
 * Role-prefixed, per-role-coloured terminal output (Issue #491, O1/O2/O3).
 * `colourEnabled`/`colourAgentLine`/`colourLoopLine` are exported for
 * exactly this reason — asserting the TTY/`NO_COLOR` predicate and the
 * per-role prefix needs no real vendor process, just a fixture stream.
 */
describe('terminal colour — role prefix and TTY/NO_COLOR gating (#491)', () => {
  const priorNoColor = process.env.NO_COLOR
  afterEach(() => {
    if (priorNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = priorNoColor
  })

  const ROLES = ['planner', 'developer', 'code-reviewer', 'security', 'principal', 'archivist', 'architect'] as const

  // Built via `new RegExp` rather than a `/\x1b.../` literal — a regex
  // LITERAL containing a raw control-character escape trips
  // `lint/suspicious/noControlCharactersInRegex`; a pattern built from a
  // string at runtime does not, and asserts exactly the same bytes.
  const ANSI_ESC = '\x1b'
  const ANSI_CODE_RE = new RegExp(`${ANSI_ESC}\\[\\d+m`)
  const ANSI_CODE_RE_G = new RegExp(`${ANSI_ESC}\\[\\d+m`, 'g')
  const ANSI_RESET_STR = `${ANSI_ESC}[0m`
  const ANSI_RESET_RE_G = new RegExp(`${ANSI_ESC}\\[0m`, 'g')
  const ANSI_ANY_RE = new RegExp(`${ANSI_ESC}\\[`)

  it('colourEnabled is true only on a live TTY with NO_COLOR unset', () => {
    delete process.env.NO_COLOR
    expect(colourEnabled({ isTTY: true })).toBe(true)
    expect(colourEnabled({ isTTY: false })).toBe(false)
    expect(colourEnabled({})).toBe(false)
    // Presence alone disables it (https://no-color.org) — even an empty value.
    process.env.NO_COLOR = ''
    expect(colourEnabled({ isTTY: true })).toBe(false)
    process.env.NO_COLOR = '1'
    expect(colourEnabled({ isTTY: true })).toBe(false)
  })

  for (const role of ROLES) {
    it(`colourAgentLine prefixes and colours a ${role} fixture line on a TTY, and gives every role a different colour`, () => {
      delete process.env.NO_COLOR
      const line = colourAgentLine(role, 'reading the brief', { isTTY: true })
      expect(line).toContain(`[${role}] reading the brief`)
      expect(line).toMatch(ANSI_CODE_RE)
      expect(line.endsWith(ANSI_RESET_STR)).toBe(true)
      // Every other role's own line carries a DIFFERENT colour code — the
      // reader is separating roles at a glance, not reading the same code
      // for two different speakers.
      for (const other of ROLES) {
        if (other === role) continue
        const otherLine = colourAgentLine(other, 'reading the brief', { isTTY: true })
        const code = (s: string) => s.match(ANSI_CODE_RE)?.[0]
        expect(code(otherLine)).not.toBe(code(line))
      }
    })
  }

  it('colourAgentLine carries the prefix with NO escape codes off a TTY or under NO_COLOR', () => {
    delete process.env.NO_COLOR
    const plain = colourAgentLine('code-reviewer', 'reading the brief', { isTTY: false })
    expect(plain).toBe('[code-reviewer] reading the brief')
    expect(plain).not.toMatch(ANSI_ANY_RE)

    process.env.NO_COLOR = '1'
    const noColour = colourAgentLine('code-reviewer', 'reading the brief', { isTTY: true })
    expect(noColour).toBe('[code-reviewer] reading the brief')
    expect(noColour).not.toMatch(ANSI_ANY_RE)
  })

  it("colourLoopLine restyles the loop's own already-role-named text without stacking a second prefix", () => {
    delete process.env.NO_COLOR
    const text = '[vinaya dispatch abc-123] developer via claude: still running — 60s elapsed (ceiling 14400s)'
    const coloured = colourLoopLine(text, { isTTY: true })
    expect(coloured).toContain(text)
    expect(coloured).toMatch(ANSI_CODE_RE)
    expect(coloured.endsWith(ANSI_RESET_STR)).toBe(true)
    // No `[role]`-shaped prefix ADDED beyond the text's own existing naming.
    expect(coloured.replace(ANSI_CODE_RE_G, '').replace(ANSI_RESET_RE_G, '')).toBe(text)

    const plain = colourLoopLine(text, { isTTY: false })
    expect(plain).toBe(text)
  })

  it('a real dispatch (non-TTY, as every spawned child always is) writes the `[role]` prefix with no escape codes to stderr, and the dispatch-output tee stays byte-identical to the raw agent line — no prefix, no colour', () => {
    const home = tempDir('vinaya-colour-home-')
    const cwd = tempDir('vinaya-colour-cwd-')
    const binDir = tempDir('vinaya-colour-bin-')
    const rawEvent = '{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}'
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '${rawEvent}'\n` +
        'echo \'{"usage":{"input_tokens":1,"output_tokens":2}}\'\nexit 0\n'
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = spawnBudgeted(
      [INDEX, 'dispatch', 'developer', '--agent', 'claude', '--prompt-file', promptFile],
      {
        encoding: 'utf8',
        cwd,
        env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
      },
      'vinaya dispatch'
    )
    expect(r.status).toBe(0)

    // O1: the rendered line carries the role prefix even off a TTY (only
    // colour is TTY-gated, never the prefix) — and no escape sequence, since
    // `execFileSync`/`spawnSync` pipes are never a live terminal.
    expect(r.stderr).toContain('[developer] hello world')
    expect(r.stderr).not.toMatch(ANSI_ANY_RE)

    // O2: the lifecycle line keeps its own existing role-naming text, with
    // no second `[developer]` prefix stacked in front of it.
    expect(r.stderr).toMatch(/\[vinaya dispatch [0-9a-f-]{36}\] developer via claude: output teed to/)
    expect(r.stderr).not.toContain('[developer] [vinaya dispatch')

    // O3: the tee file never sees the rendered/prefixed stderr lines at
    // all — it tees the child's raw stdout/stderr chunks — so it carries the
    // exact bytes the fake agent printed, byte-identical to before this task.
    const teeDir = join(home, '.vinaya', 'runtime', 'unresolved', 'tasks-execution', 'unscoped', 'output')
    const logs = readdirSync(teeDir)
    expect(logs).toHaveLength(1)
    const teeContents = readFileSync(join(teeDir, logs[0] as string), 'utf8')
    expect(teeContents).toContain(rawEvent)
    expect(teeContents).not.toContain('[developer]')
    expect(teeContents).not.toMatch(ANSI_ANY_RE)
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

describe('sawVendorConnectionRetry (pure) — [task-operator-v1]/Issue #662, O2', () => {
  it('true for a real api_retry line, confirmed-live shape (claude CLI 2.1.197)', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 504.3,
        error_status: null,
        error: 'unknown',
        session_id: 's1'
      })
    ].join('\n')
    expect(sawVendorConnectionRetry(stream)).toBe(true)
  })

  it('false for an ordinary stream with no retry marker', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ stop_reason: 'end_turn', session_id: 's1' })
    ].join('\n')
    expect(sawVendorConnectionRetry(stream)).toBe(false)
  })

  it('false for empty output, and never throws on non-JSON lines', () => {
    expect(sawVendorConnectionRetry('')).toBe(false)
    expect(sawVendorConnectionRetry('not json\nalso not json')).toBe(false)
  })

  it('false for a subtype: api_retry on a DIFFERENT type — the exact shape, not a loose substring match', () => {
    const stream = JSON.stringify({ type: 'assistant', subtype: 'api_retry' })
    expect(sawVendorConnectionRetry(stream)).toBe(false)
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
      // O1 (#543): claude alone gets a trailing `--settings <path>` pair.
      const actualArgv = readArgv(argvOut)
      if (fixture.agent === 'claude') {
        expect(actualArgv.slice(-2, -1)).toEqual(['--settings'])
        expect(actualArgv.slice(0, -2)).toEqual(fixture.argv)
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
    expect(actualArgv.slice(0, -2)).toEqual(['-p', '--verbose', '--output-format', 'stream-json'])
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

    const r = spawnBudgeted(
      [INDEX, 'dispatch', 'developer', '--agent', 'codex', '--prompt-file', promptFile, '--model', 'claude-opus-5'],
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

  it('never wires --settings for codex or gemini — no confirmed-live equivalent deny mechanism for either', () => {
    for (const agent of ['codex', 'gemini']) {
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
      'Bash(git commit:*)',
      'Bash(git push:*)',
      'Bash(gh pr create:*)',
      'Bash(gh issue view:*)',
      'Bash(bun install:*)',
      'Bash(bun test:*)',
      'Bash(bun run:*)'
    ]) {
      expect(perms.allow).toContain(rule)
    }
    expect(perms.allow.some((r) => r.startsWith('Write(') || r.startsWith('Edit('))).toBe(false)
  })

  it('developer: forbidden shapes doctrine names are denied, narrower than the broader allow rule that would otherwise cover them', () => {
    const perms = buildRolePermissions('developer')
    for (const rule of [
      'Bash(git push --force*)',
      'Bash(git push -f*)',
      'Bash(git commit --no-verify*)',
      'Bash(git stash*)',
      'Bash(git reset --hard*)',
      'Bash(rm -rf*)',
      'Bash(sudo*)'
    ]) {
      expect(perms.deny).toContain(rule)
    }
    // Every deny rule is a narrower shape than some broader allow rule
    // already granted (`git push`, `git commit`) — proving these are
    // real overrides, not merely commands that were never allowed at all.
    expect(perms.allow).toContain('Bash(git push:*)')
    expect(perms.allow).toContain('Bash(git commit:*)')
  })

  for (const role of ['code-reviewer', 'security'] as const) {
    it(`${role}: read-only git/gh commands allowed, no Write/Edit entry at all, forge-write/package/test commands denied`, () => {
      const perms = buildRolePermissions(role)
      for (const rule of ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(gh pr view:*)', 'Bash(gh issue view:*)']) {
        expect(perms.allow).toContain(rule)
      }
      expect(perms.allow.some((r) => r.startsWith('Write(') || r.startsWith('Edit('))).toBe(false)
      for (const rule of [
        'Bash(git push:*)',
        'Bash(git commit:*)',
        'Bash(gh pr create:*)',
        'Bash(gh pr merge:*)',
        'Bash(bun install:*)',
        'Bash(bun test:*)',
        'Bash(bun run:*)'
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

describe('buildWriteAccessScope — Issue #663, O1 round 2 fix: the real Write/Edit grant', () => {
  it('developer: a directory scope, realpath-resolved', () => {
    const dir = tempDir('vinaya-write-scope-')
    const scope = buildWriteAccessScope('developer', dir, [])
    expect(scope).toEqual({ kind: 'directory', allowedDir: realpathSync(dir), extraFiles: [] })
  })

  it('developer: extraFiles (O3, task-files-v1 2, #649) carries this round’s confidence/round-response paths, realpath-resolved, alongside the worktree directory grant', () => {
    const dir = tempDir('vinaya-write-scope-')
    const devDir = tempDir('vinaya-write-scope-dev-')
    const confidence = join(devDir, '.vinaya-confidence')
    const roundResponse = join(devDir, '.vinaya-round-response')
    const scope = buildWriteAccessScope('developer', dir, [], [confidence, roundResponse])
    // Resolved through the parent, exactly as `writeAccessHookScript` resolves
    // the path it compares against: on a host whose temp root is a symlink
    // (macOS `/var` → `/private/var`), a raw expectation here fails while the
    // grant is correct — the sibling symlinked-ancestor test below asserts the
    // same resolution deliberately.
    const realDevDir = realpathSync(devDir)
    expect(scope).toEqual({
      kind: 'directory',
      allowedDir: realpathSync(dir),
      extraFiles: [join(realDevDir, '.vinaya-confidence'), join(realDevDir, '.vinaya-round-response')]
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
    const confidence = join(devDir, '.vinaya-confidence')

    const scope = buildWriteAccessScope('developer', dir, [], [confidence])
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
    expect(resolved).toBe(join(realpathSync(devDir), '.vinaya-confidence'))
  })

  it('a role other than developer never gets developerFiles applied', () => {
    const a = tempDir('vinaya-write-scope-a-')
    const scope = buildWriteAccessScope('code-reviewer', '/unused', [a], ['/some/absolute/path'])
    expect(scope).toEqual({
      kind: 'exact-files',
      paths: [
        join(realpathSync(a), 'findings.txt'),
        join(realpathSync(a), 'report.txt'),
        join(realpathSync(a), 'objectives.txt')
      ]
    })
  })

  for (const role of ['code-reviewer', 'security'] as const) {
    it(`${role}: exact hand-off files across every extraWritableDirs entry, realpath-resolved`, () => {
      const a = tempDir('vinaya-write-scope-a-')
      const b = tempDir('vinaya-write-scope-b-')
      const scope = buildWriteAccessScope(role, '/unused', [a, b])
      expect(scope).toEqual({
        kind: 'exact-files',
        paths: [
          join(realpathSync(a), 'findings.txt'),
          join(realpathSync(a), 'report.txt'),
          join(realpathSync(a), 'objectives.txt'),
          join(realpathSync(b), 'findings.txt'),
          join(realpathSync(b), 'report.txt'),
          join(realpathSync(b), 'objectives.txt')
        ]
      })
    })

    it(`${role}: no extraWritableDirs at all — null, no hook to wire`, () => {
      expect(buildWriteAccessScope(role, '/unused', [])).toBeNull()
    })
  }

  it('a role outside the three named — null', () => {
    expect(buildWriteAccessScope('planner', tempDir('vinaya-write-scope-'), [])).toBeNull()
  })

  it('a directory that does not exist yet degrades to its own raw form rather than throwing', () => {
    const scope = buildWriteAccessScope('developer', '/tmp/does-not-exist-vinaya-663', [])
    expect(scope).toEqual({ kind: 'directory', allowedDir: '/tmp/does-not-exist-vinaya-663', extraFiles: [] })
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
    const confidencePath = join(devFilesDir, '.vinaya-confidence')
    const roundResponsePath = join(devFilesDir, '.vinaya-round-response')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
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

  it('developerFiles behind a symlinked ancestor still ALLOWS end to end — the grant and the live hook check agree (round 2 review, MAJOR)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const realDevFilesDir = tempDir('vinaya-dispatch-devfiles-real-')
    const linkContainer = tempDir('vinaya-dispatch-devfiles-link-')
    const linkedDevFilesDir = join(linkContainer, 'developer')
    symlinkSync(realDevFilesDir, linkedDevFilesDir)
    // Named through the SYMLINK, exactly as `dev-review-loop.ts`'s
    // `confidenceFilePathFor` would if `runtimeDir` itself traversed one
    // (`/var` → `/private/var`, this reference's own documented example) —
    // never created, matching the real "not written yet this round" case.
    const confidencePath = join(linkedDevFilesDir, '.vinaya-confidence')
    const argvOut = join(cwd, 'argv.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
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
    // No extraWritableDirs on a plain CLI dispatch (the CLI has no flag for
    // it — only `dev-review-loop.ts`'s own internal call site ever supplies
    // one) — `buildWriteAccessScope` returns null, so no Write|Edit hook is
    // wired at all: never a blanket grant a Reviewer's own doctrine forbids.
    expect(settings.hooks.PreToolUse.some((h) => h.matcher === 'Write|Edit')).toBe(false)
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

describe('unreadDocumentationSources', () => {
  it('reports a URL-shaped source never fetched', () => {
    const sources = [{ source: 'https://example.com/docs/a', mechanism: 'the mechanism it governs', objectiveIds: [1] }]
    expect(unreadDocumentationSources(sources, [])).toEqual(sources)
  })

  it('clears a source once its exact URL was fetched', () => {
    const sources = [{ source: 'https://example.com/docs/a', mechanism: 'x', objectiveIds: [1] }]
    expect(unreadDocumentationSources(sources, ['https://example.com/docs/a'])).toEqual([])
  })

  it('tolerates a trailing slash or fragment difference on either side', () => {
    const sources = [{ source: 'https://example.com/docs/a/', mechanism: 'x', objectiveIds: [1] }]
    expect(unreadDocumentationSources(sources, ['https://example.com/docs/a#section'])).toEqual([])
  })

  it('never reports a non-URL (in-repo path) source — WebFetch cannot answer for it', () => {
    const sources = [{ source: 'apps/cli/specs/loop.md', mechanism: 'x', objectiveIds: [1] }]
    expect(unreadDocumentationSources(sources, [])).toEqual([])
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
        input: JSON.stringify({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com/docs/fixture' } }),
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
        input: JSON.stringify({ tool_name: 'WebFetch', tool_input: { url: hyphenatedUrl } }),
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

  it('warns only for a vendor whose Documentation gate remains unenforced', () => {
    for (const agent of ['gemini']) {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      writeFakeBinary(binDir, agent, `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, DOC_PROMPT)

      const r = spawnBudgeted(
        [INDEX, 'dispatch', 'developer', '--agent', agent, '--prompt-file', promptFile],
        {
          encoding: 'utf8',
          cwd,
          env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
        },
        'vinaya dispatch'
      )
      expect(r.status).toBe(0)
      expect(r.stderr).toContain('Documentation read-gate')
      expect(r.stderr).toContain(agent)
    }

    {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      writeFakeBinary(binDir, 'codex', `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, DOC_PROMPT)
      const result = spawnBudgeted(
        [INDEX, 'dispatch', 'developer', '--agent', 'codex', '--prompt-file', promptFile],
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
      [INDEX, 'dispatch', 'developer', '--agent', 'codex', '--prompt-file', promptFile],
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

/**
 * `recoverUsageFromDispatchTee` (O1, #608) — entirely deps-injected, so
 * every case here is a fixture: a fake env, a fake set of launch-record
 * files, and fake tee bytes, never this machine's real `~/.vinaya/`.
 */
describe('recoverUsageFromDispatchTee (O1, #608)', () => {
  const LAUNCH_RECORD_PATH = '/fake/tasks-execution/608/sessions/developer-claude.json'

  function launchRecordJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      runId: 'run-1',
      role: 'developer',
      agent: 'claude',
      repo: { owner: 'owner', repo: 'repo' },
      task: 608,
      pr: null,
      round: null,
      attempt: 1,
      effectId: 'effect-abc',
      dispatcherPid: 1,
      childPid: 2,
      host: 'test-host',
      startedAt: '2026-09-14T00:00:00.000Z',
      status: 'completed',
      resumeId: 'resume-1',
      boundAt: '2026-09-14T00:00:00.000Z',
      finishedAt: '2026-09-14T00:01:00.000Z',
      failureReason: null,
      ...overrides
    })
  }

  function assistantLine(id: string, inputTokens: number, outputTokens: number): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        id,
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    })
  }

  function fakeDeps(opts: {
    env?: Record<string, string | undefined>
    launchRecord?: string | null
    teeLog?: string | null
  }): DispatchTeeRecoveryDeps {
    const env = opts.env ?? { VINAYA_RUN_ID: 'run-1', VINAYA_ROLE: 'developer', VINAYA_TASK: '608' }
    return {
      env,
      listLaunchRecordPaths: () => [LAUNCH_RECORD_PATH],
      readFile: (path: string) => {
        if (path === LAUNCH_RECORD_PATH) {
          if (opts.launchRecord === null) throw new Error('ENOENT')
          return opts.launchRecord ?? launchRecordJson()
        }
        if (path.endsWith('effect-abc.log')) {
          if (opts.teeLog === null) throw new Error('ENOENT')
          return opts.teeLog ?? `${assistantLine('msg_1', 100, 10)}\n${assistantLine('msg_2', 50, 5)}`
        }
        throw new Error(`unexpected read: ${path}`)
      }
    }
  }

  it('sums per-message usage from the matching effect id, deduping by message id', () => {
    const teeLog = [
      assistantLine('msg_1', 100, 10),
      assistantLine('msg_1', 100, 10), // duplicate id — same turn re-emitted mid-stream, must not double-count
      assistantLine('msg_2', 50, 5)
    ].join('\n')
    const result = recoverUsageFromDispatchTee(fakeDeps({ teeLog }))
    expect(result).not.toBeNull()
    expect(result?.summary.components.inputTokens).toBe(150)
    expect(result?.summary.components.outputTokens).toBe(15)
    expect(result?.summary.messageCount).toBe(2)
    expect(result?.teePath.endsWith('effect-abc.log')).toBe(true)
  })

  it('no VINAYA_RUN_ID in env: null, never guesses', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ env: { VINAYA_ROLE: 'developer', VINAYA_TASK: '608' } }))).toBeNull()
  })

  it('no VINAYA_TASK in env: null', () => {
    expect(
      recoverUsageFromDispatchTee(fakeDeps({ env: { VINAYA_RUN_ID: 'run-1', VINAYA_ROLE: 'developer' } }))
    ).toBeNull()
  })

  it('a launch record exists but for a different runId: null — never another session’s figures', () => {
    const result = recoverUsageFromDispatchTee(fakeDeps({ launchRecord: launchRecordJson({ runId: 'other-run' }) }))
    expect(result).toBeNull()
  })

  it('a launch record exists but for a different task: null', () => {
    const result = recoverUsageFromDispatchTee(fakeDeps({ launchRecord: launchRecordJson({ task: 999 }) }))
    expect(result).toBeNull()
  })

  it('no launch record on disk at all: null, never throws', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ launchRecord: null }))).toBeNull()
  })

  it('launch record found but its tee log is unreadable: null, never throws', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ teeLog: null }))).toBeNull()
  })

  it('tee log yields zero usable assistant messages: null', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ teeLog: 'not json\n\n' }))).toBeNull()
  })

  it('a corrupt (non-JSON) launch record file: null, never throws', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ launchRecord: 'not json' }))).toBeNull()
  })
})

/**
 * O2 (Issue #670) — the host-wide proof, run last so it observes every
 * fixture above's own teardown, not just the one test it happens to follow.
 * Same idiom `checks/runner.test.ts` already established for its own
 * process-group tests (`ps -eo pid,command | grep … | grep -v grep || true`)
 * — `-eo` lists every process on the host, not just this test process's own
 * children, so a vendor that reparented to the service manager after its own
 * script died is still caught here. Every fake vendor binary in this file
 * lives under a `tempDir('vinaya-dispatch-bin-')` directory, so its own
 * path — and therefore its `ps` command line — always carries that literal
 * substring; a `--settings <path>` flag (`writeDispatchSettings`) on an
 * unattended fixture additionally carries the fake task's own run folder, on
 * the SAME command line, for the same reason. Bounded (`timeout`/
 * `killSignal`) so a hung `ps`/`grep` cannot itself hang this file's own run
 * — matching this file's own `stripVinayaEnv`+kill-budget discipline
 * (`process-fixture-coverage.test.ts`).
 *
 * The proof is against pids NEW since `beforeAll`, never a bare host-wide
 * zero-count: this machine runs several agents concurrently, each in its own
 * worktree sharing the same real host — an unrelated sibling's own
 * in-flight `vinaya-dispatch-bin-` fixture, alive before this file's first
 * test ever ran, is not a regression this file introduced and must never
 * fail this proof (found live: a sibling worktree's own fixture, started
 * independently, made a bare `ps -eo` scan fail with no leak on this file's
 * own part at all). Snapshotting the baseline first and asserting "nothing
 * new" keeps 100% of the sensitivity to a real leak from this file's own
 * fixtures while dropping the false positive from noise this file never
 * controlled.
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

describe('process hygiene (Issue #670) — the file leaves no fake vendor process behind', () => {
  it('no NEW process — beyond whatever the host already carried before this file ran — still carries a vinaya-dispatch-bin- path in its command line', () => {
    const newSurvivors = vendorProcessSurvivors().filter((line) => !preExistingVendorSurvivors.has(line))
    expect(newSurvivors).toEqual([])
  })
})
