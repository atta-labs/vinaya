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
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import {
  AGENT_VENDOR_NAMES,
  DEFAULT_TIMEOUT_MS,
  identifyVendorFromModelShape,
  parseClaudeModel,
  parseClaudeResumeId,
  parseClaudeUsage,
  readClaudeTranscriptUsage,
  resolveClaudeUsageUnits,
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
  buildCodexExecpolicyRules,
  buildWriteAccessScope,
  writeAccessHookScript,
  addCodexWritableDirs,
  PERMISSION_POLICY_VERSION,
  codexSpawnEnvExtras,
  missingSubscriptionLoginReason,
  NO_SUBSCRIPTION_LOGIN_REASON,
  codexBoundaryFailureReason,
  confinedTurboEnv,
  developerWrittenTextFromVendorOutput,
  type DispatchTeeRecoveryDeps
} from '../../src/lib/dispatch.js'
import { addedDiffLines, agentConfigProtectedSubpaths, findCredentialPatterns } from '../../src/lib/worker-boundary.js'

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
  // The real path: macOS reaches its temporary directory through a symlink, and
  // tests that compare paths must see the same spelling the product resolves to.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
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
  // Left in place, a leaked GITHUB_ACTIONS makes a spawned child's own
  // log() resolve its destination to 'none' (log-sink.ts's
  // resolveLogDestinationFrom) instead of the folder/server a test expects
  // — the same leak #721 fixed for the in-process loop harness.
  delete out.GITHUB_ACTIONS
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
    .filter((e) => !(e.kind === 'operation' && e.operation === 'cli_command'))
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

  // O1/O3: the value a dispatched role reads to recognize its OWN driver. The
  // regression it closes: a Developer ran `ps`, found the `vinaya task run`
  // process that had launched it, read two runs racing on one branch, and
  // stopped before its first step. The driver is this launching process — not
  // the vendor CLI it spawns — so the assertion compares the value the child
  // received against the launch record's own `dispatcherPid`, which the driver
  // wrote about ITSELF (`process.pid`) before spawning anything. Run for a
  // code-reviewer as well as a developer: the value is set beside the attribution
  // every role already receives, never only the developer's.
  for (const [role, task] of [
    ['developer', 9101],
    ['code-reviewer', 9102]
  ] as const) {
    it(`tells a dispatched ${role} its own driver's pid, equal to the driver's own`, () => {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      const driverPidOut = join(cwd, 'driver-pid.out')
      // Reads back exactly one environment value and nothing else — and
      // drains stdin, the way every other fake vendor in this file does,
      // because a real vendor reads its prompt from there. The first version
      // of this fixture exited without reading it and the dispatch came back
      // non-zero on the Linux CI runner (`Test (apps/cli, shard 2)`) while
      // passing on the authoring macOS host — the one structural difference
      // from this file's long-passing sibling fixture, which drains it.
      writeFakeBinary(
        binDir,
        'claude',
        `#!/bin/sh\ncat > /dev/null\nprintf '%s' "$VINAYA_DRIVER_PID" > "${driverPidOut}"\nexit 0\n`
      )
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)

      const r = runDispatch(
        [role, '--agent', 'claude', '--prompt-file', promptFile, '--task', String(task)],
        cwd,
        home,
        `${binDir}:${pathWithoutRealVendors()}`
      )
      // Named rather than asserted bare: a non-zero status here is always a
      // dispatch that refused or died, and its own stderr says which.
      if (r.status !== 0) {
        throw new Error(`vinaya dispatch exited ${r.status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`)
      }

      const received = readFileSync(driverPidOut, 'utf8')
      expect(received).toMatch(/^[0-9]+$/)

      const record = JSON.parse(
        readFileSync(
          join(
            home,
            '.vinaya',
            'runtime',
            'unresolved',
            'tasks-execution',
            String(task),
            'sessions',
            `${role}-claude.json`
          ),
          'utf8'
        )
      ) as { dispatcherPid: number }
      expect(Number.parseInt(received, 10)).toBe(record.dispatcherPid)
    })
  }

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
    expect(withoutTurnResultFlag(readArgv(argvOut), '--output-schema')).toEqual([
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

// A Claude dispatch whose stream ends without a usage line records the usage
// its session transcript holds instead, and records unknown only with a reason.
const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001'

function transcriptLine(id: string, input: number, output: number, cacheCreate: number, cacheRead: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-x',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead
      }
    }
  })
}

function plantTranscript(configDir: string, sessionId: string, lines: string[]): string {
  const dir = join(configDir, 'projects', '-some-project')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

describe('readClaudeTranscriptUsage', () => {
  it('sums input, output and cache once per unique message', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    plantTranscript(configDir, SESSION_ID, [
      transcriptLine('m1', 10, 5, 100, 200),
      transcriptLine('m1', 10, 5, 100, 200),
      transcriptLine('m2', 1, 2, 3, 4)
    ])
    expect(readClaudeTranscriptUsage(SESSION_ID, configDir)).toEqual({
      units: { input: 11, output: 7, cache: 307 },
      unknownReason: null
    })
  })

  it('is unknown with a reason, never zero, when there is no session id, no file, or no message', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    const noId = readClaudeTranscriptUsage(null, configDir)
    expect(noId.units).toEqual({ input: null, output: null, cache: null })
    expect(noId.unknownReason).toContain('session identifier')
    const missing = readClaudeTranscriptUsage(SESSION_ID, configDir)
    expect(missing.units).toEqual({ input: null, output: null, cache: null })
    expect(missing.unknownReason).toContain('session transcript')
    plantTranscript(configDir, SESSION_ID, ['not json', JSON.stringify({ type: 'user' })])
    const empty = readClaudeTranscriptUsage(SESSION_ID, configDir)
    expect(empty.units).toEqual({ input: null, output: null, cache: null })
    expect(empty.unknownReason).toContain('no assistant message')
  })

  it('refuses an identifier that would escape the transcript directory', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    const outside = join(configDir, 'secret')
    writeFileSync(`${outside}.jsonl`, `${transcriptLine('m1', 9, 9, 9, 9)}\n`)
    mkdirSync(join(configDir, 'projects', 'p'), { recursive: true })
    const r = readClaudeTranscriptUsage('../../secret', configDir)
    expect(r.units).toEqual({ input: null, output: null, cache: null })
    expect(r.unknownReason).not.toBeNull()
  })

  it('refuses a transcript symlinked to a file outside the projects directory', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    const outsideDir = tempDir('vinaya-transcript-outside-')
    const outside = join(outsideDir, 'real.jsonl')
    writeFileSync(outside, `${transcriptLine('m1', 9, 9, 9, 9)}\n`)
    const dir = join(configDir, 'projects', 'p')
    mkdirSync(dir, { recursive: true })
    symlinkSync(outside, join(dir, `${SESSION_ID}.jsonl`))
    const r = readClaudeTranscriptUsage(SESSION_ID, configDir)
    expect(r.units).toEqual({ input: null, output: null, cache: null })
    expect(r.unknownReason).toContain('no transcript for session')
  })
})

describe('resolveClaudeUsageUnits', () => {
  const streamKnown = { units: { input: 1, output: 2, cache: 3 }, unknownReason: null }
  const streamUnknown = {
    units: { input: null, output: null, cache: null },
    unknownReason: 'claude emitted no stream-json line'
  }

  it('keeps the stream figures and never reads the transcript when the stream carried usage', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    plantTranscript(configDir, SESSION_ID, [transcriptLine('m1', 999, 999, 999, 999)])
    expect(resolveClaudeUsageUnits(streamKnown, SESSION_ID, configDir)).toEqual({
      observation: streamKnown,
      source: 'stream'
    })
  })

  it('uses the transcript alone, labelled as its source, when the stream had none', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    plantTranscript(configDir, SESSION_ID, [transcriptLine('m1', 10, 5, 1, 2)])
    expect(resolveClaudeUsageUnits(streamUnknown, SESSION_ID, configDir)).toEqual({
      observation: { units: { input: 10, output: 5, cache: 3 }, unknownReason: null },
      source: 'claude-transcript'
    })
  })

  it('names both sources in the reason when neither yields usage', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    const r = resolveClaudeUsageUnits(streamUnknown, SESSION_ID, configDir)
    expect(r.source).toBe('stream')
    expect(r.observation.units).toEqual({ input: null, output: null, cache: null })
    expect(r.observation.unknownReason).toContain('claude emitted no stream-json line')
    expect(r.observation.unknownReason).toContain('session transcript')
  })
})

describe('dispatchRole — transcript usage fallback', () => {
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID })

  it('a clean exit with no usage line records the transcript totals as the claude-transcript source', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    plantTranscript(join(home, '.claude'), SESSION_ID, [
      transcriptLine('m1', 100, 20, 30, 40),
      transcriptLine('m1', 100, 20, 30, 40),
      transcriptLine('m2', 1, 2, 3, 4)
    ])
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '${initLine}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    const usageEvents = (outboxLines(home, 'none') as Array<Record<string, unknown>>).filter((l) => l.kind === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      source: 'claude-transcript',
      semantics: 'cumulative',
      units: { input: 101, output: 22, cache: 77 },
      unknown_reason: null
    })
  }, 20_000)

  it('a killed dispatch still records the usage its transcript holds so far', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    plantTranscript(join(home, '.claude'), SESSION_ID, [transcriptLine('m1', 7, 8, 9, 10)])
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\necho '${initLine}'\ntrap '' TERM\ncat > /dev/null &\nsleep 30\n`)
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
    expect(lines.find((l) => l.event === 'dispatch_failed')).toMatchObject({ reason: 'timeout' })
    expect(lines.find((l) => l.kind === 'usage')).toMatchObject({
      source: 'claude-transcript',
      units: { input: 7, output: 8, cache: 19 },
      unknown_reason: null
    })
  }, 20_000)

  it('with neither a stream usage line nor a transcript the units are unknown and the reason names both', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '${initLine}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    const usage = (outboxLines(home, 'none') as Array<Record<string, unknown>>).find((l) => l.kind === 'usage') as {
      source: string
      units: Record<string, unknown>
      unknown_reason: string
    }
    expect(usage.source).toBe('claude')
    expect(usage.units).toEqual({ input: null, output: null, cache: null })
    expect(usage.unknown_reason).toContain('claude emitted no stream-json line')
    expect(usage.unknown_reason).toContain('session transcript')
  }, 20_000)
})

// O4 — the Vinaya log's `usage` event is the record of a turn's token use now
// that a pull-request body carries no token table. Nothing in the collection
// path reads a PR body, so a clean dispatch still lands real figures: this
// pins that end to end, against a fake role whose stdout carries exactly the
// stream-json shape `parseClaudeUsage` reads.
describe("dispatchRole — a dispatched role's usage event survives the PR-body token table's retirement", () => {
  it('a clean dispatch emits one usage event carrying the real input/output/cache figures', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '{"usage":{"input_tokens":91442,"output_tokens":7318,"cache_creation_input_tokens":40,"cache_read_input_tokens":60}}'\nexit 0\n`
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

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const usageEvents = lines.filter((l) => l.kind === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      event: 'observed',
      // Both Anthropic cache fields sum into one figure — see `parseUsageDetail`.
      units: { input: 91442, output: 7318, cache: 100 },
      unknown_reason: null
    })
    // The turn itself is a clean one, so no failure path supplied these numbers.
    expect(lines.find((l) => l.event === 'dispatch_failed')).toBeUndefined()
    expect(lines.find((l) => l.event === 'outcome_received')).toBeDefined()
  })
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

/**
 * A Developer dispatch's argv with its turn-result flag pair removed —
 * Claude's `--json-schema <schema>`, Codex's `--output-schema <file>` —
 * asserting the pair was there: every Developer dispatch asks for its turn
 * result as the CLI's native structured output (#1125).
 */
function withoutTurnResultFlag(argv: string[], flag: '--json-schema' | '--output-schema'): string[] {
  const i = argv.indexOf(flag)
  expect(i).toBeGreaterThanOrEqual(0)
  expect(argv[i + 1]?.length ?? 0).toBeGreaterThan(0)
  return [...argv.slice(0, i), ...argv.slice(i + 2)]
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
        expect(withoutTurnResultFlag(actualArgv.slice(0, -2), '--json-schema')).toEqual(fixture.resumeArgv(synthId))
      } else if (fixture.agent === 'codex') {
        expect(withoutTurnResultFlag(actualArgv, '--output-schema')).toEqual(fixture.resumeArgv(synthId))
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

describe('developerWrittenTextFromVendorOutput + the after-turn credential scan — O4 (#1046): only what the turn wrote', () => {
  const REPO_ROOT = join(CLI_ROOT, '..', '..')
  // The two credential-shaped test FIXTURES the brief names, read VERBATIM — so
  // this test proves the scan tolerates the actual bytes this repo ships, not a
  // stand-in. Both carry real credential shapes (an AWS key, a Slack token, an
  // Anthropic key, a PEM block) as fixture values that are not secrets at all.
  const workerBoundaryFixture = readFileSync(
    join(CLI_ROOT, 'tests', 'lib', 'dispatch', 'worker-boundary.test.ts'),
    'utf8'
  )
  const redactFixture = readFileSync(join(REPO_ROOT, 'packages', 'aeg-core', 'src', 'log', 'redact.test.ts'), 'utf8')

  // A Claude `--output-format stream-json` tee for a turn that READ both
  // fixtures: the agent's own message, a `Read` tool_use naming each file (the
  // PATH only), each file's full content coming back as a tool_result (where the
  // credential shapes live), and a benign closing message.
  function readingTurnTee(): string {
    return [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the fixtures.' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: 'apps/cli/tests/lib/dispatch/worker-boundary.test.ts' }
            }
          ]
        }
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: workerBoundaryFixture }] } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'packages/aeg-core/src/log/redact.test.ts' } }
          ]
        }
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: redactFixture }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Done reading; nothing to change.' }] }
      })
    ].join('\n')
  }

  it('a turn that READS the two credential-shaped fixtures is not refused — their contents arrive as tool results the extractor drops', () => {
    const written = developerWrittenTextFromVendorOutput(readingTurnTee(), 'claude')
    // It kept the agent's own messages and the Read tool-use PATHS...
    expect(written).toContain('Reading the fixtures.')
    expect(written).toContain('⚙ Read: apps/cli/tests/lib/dispatch/worker-boundary.test.ts')
    // ...and dropped both tool RESULTS, so neither fixture's credential shape is
    // in the scanned text, and the credential scan finds nothing.
    expect(findCredentialPatterns(written, "the Developer's own turn output")).toEqual([])
  })

  it('a turn whose diff ADDS a credential-shaped line is still refused; the same shape only in unchanged context is not', () => {
    const secret = `ghp_${'A'.repeat(40)}`
    const addsIt = ['--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1,2 @@', ' const a = 1', `+const t = '${secret}'`].join(
      '\n'
    )
    const added = addedDiffLines(addsIt)
    expect(added).toContain(secret)
    expect(findCredentialPatterns(added, 'the diff lines this turn added').length).toBeGreaterThan(0)

    // The same secret sitting only in an UNCHANGED context line (a hunk the turn
    // edited nearby but did not write the secret into) is never flagged.
    const contextOnly = [
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,2 +1,2 @@',
      ` const t = '${secret}'`,
      '-const a = 1',
      '+const a = 2'
    ].join('\n')
    const addedCtx = addedDiffLines(contextOnly)
    expect(addedCtx).not.toContain(secret)
    expect(findCredentialPatterns(addedCtx, 'the diff lines this turn added')).toEqual([])
  })

  it('the `+++` file header is never treated as an added line, even though it begins with `+`', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -0,0 +1 @@', '+real content'].join('\n')
    expect(addedDiffLines(diff)).toBe('real content')
  })

  it('retains added content whose first characters are plus signs', () => {
    const secret = `ghp_${'A'.repeat(40)}`
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -0,0 +1 @@', `+++ ${secret}`].join('\n')
    expect(findCredentialPatterns(addedDiffLines(diff), 'added diff')).toHaveLength(1)
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
    it(`${role}: read-only git commands allowed, no gh and no Write/Edit entry at all, forge-write/package/test commands denied (task 992, O2)`, () => {
      const perms = buildRolePermissions(role)
      for (const rule of ['Bash(git diff:*)', 'Bash(git log:*)']) {
        expect(perms.allow).toContain(rule)
      }
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
      expect(perms.allow).toContain('Bash(git log:*)')
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
    expect(scope).toEqual({ kind: 'directory', allowedDir: realpathSync(dir), extraFiles: [], protectedSubpaths: [] })
  })

  it('developer: extraFiles (O3, task-files-v1 2, #649) carries the exact files the driver names, realpath-resolved, alongside the worktree directory grant', () => {
    const dir = tempDir('vinaya-write-scope-')
    const devDir = tempDir('vinaya-write-scope-dev-')
    const confidence = join(devDir, 'granted-one.txt')
    const roundResponse = join(devDir, 'granted-two.txt')
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
      extraFiles: [join(realDevDir, 'granted-one.txt'), join(realDevDir, 'granted-two.txt')],
      protectedSubpaths: []
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
    expect(resolved).toBe(join(realpathSync(devDir), 'granted-one.txt'))
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
    expect(scope).toEqual({
      kind: 'directory',
      allowedDir: '/tmp/does-not-exist-vinaya-663',
      extraFiles: [],
      protectedSubpaths: []
    })
  })

  it('developer: protectedSubpaths (O3) carries the realpath-resolved agent-config paths the caller named', () => {
    const dir = tempDir('vinaya-write-scope-protected-')
    const protectedPath = join(dir, '.claude')
    const scope = buildWriteAccessScope('developer', dir, [], [], [protectedPath])
    expect(scope).toEqual({
      kind: 'directory',
      allowedDir: realpathSync(dir),
      extraFiles: [],
      protectedSubpaths: [join(realpathSync(dir), '.claude')]
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
    const scope = buildWriteAccessScope(
      'developer',
      worktree,
      [],
      [],
      agentConfigProtectedSubpaths(worktree, 'claude', false)
    )
    writeFileSync(join(scriptDir, `write-access-${runId}.json`), JSON.stringify(scope))

    const decision = runHook(scriptDir, runId, join(realpathSync(worktree), '.claude', 'settings.json'))
    expect(decision.permissionDecision).toBe('deny')
    expect(decision.permissionDecisionReason).toMatch(/configuration/)

    // An ordinary file elsewhere in the same worktree stays allowed —
    // protection is scoped to exactly the named agent-config path.
    const ordinary = runHook(scriptDir, runId, join(realpathSync(worktree), 'src', 'index.ts'))
    expect(ordinary.permissionDecision).toBe('allow')
  })

  it('allows a write to .claude/settings.json when the Surface covers it (protectedSubpaths empty)', () => {
    const scriptDir = tempDir('vinaya-write-access-covered-')
    const worktree = tempDir('vinaya-write-access-covered-wt-')
    const runId = randomUUID()
    const scope = buildWriteAccessScope(
      'developer',
      worktree,
      [],
      [],
      agentConfigProtectedSubpaths(worktree, 'claude', true)
    )
    writeFileSync(join(scriptDir, `write-access-${runId}.json`), JSON.stringify(scope))

    const decision = runHook(scriptDir, runId, join(realpathSync(worktree), '.claude', 'settings.json'))
    expect(decision.permissionDecision).toBe('allow')
  })

  it('also denies a write to the bare .mcp.json file (Claude)', () => {
    const scriptDir = tempDir('vinaya-write-access-mcpjson-')
    const worktree = tempDir('vinaya-write-access-mcpjson-wt-')
    const runId = randomUUID()
    const scope = buildWriteAccessScope(
      'developer',
      worktree,
      [],
      [],
      agentConfigProtectedSubpaths(worktree, 'claude', false)
    )
    writeFileSync(join(scriptDir, `write-access-${runId}.json`), JSON.stringify(scope))

    expect(runHook(scriptDir, runId, join(realpathSync(worktree), '.mcp.json')).permissionDecision).toBe('deny')
  })

  it("denies a write to Codex's own .codex/ and .agents/ paths the same way", () => {
    const scriptDir = tempDir('vinaya-write-access-codex-')
    const worktree = tempDir('vinaya-write-access-codex-wt-')
    const runId = randomUUID()
    const scope = buildWriteAccessScope(
      'developer',
      worktree,
      [],
      [],
      agentConfigProtectedSubpaths(worktree, 'codex', false)
    )
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
    it(`a ${role} dispatch's exact-files scope DENIES a Write and an Edit to a path outside its own hand-off files (round 2 BLOCKER fix) — the gap O4 left open for this scope kind, now closed the same way`, () => {
      // Before this fix, `exact-files` scope (the Reviewer/Security's own
      // `findings.txt`/`report.txt`/`objectives.txt` hand-off files) fell
      // through silently outside its own allowlist — only `directory` scope
      // (the Developer's worktree) denied explicitly (O4). That left a
      // reviewer/security Write/Edit outside its three named files resolving
      // through the host's own default classifier instead of this hook's own
      // written restriction, exactly the gap O4 had just closed one role
      // over. `extraWritableDirs` has no CLI flag (same reasoning the
      // `developerFiles` test above gives — only `dev-review-loop.ts`'s
      // internal call site ever supplies one), so this calls `dispatchRole`
      // directly rather than through the `vinaya dispatch` CLI.
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

      const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
      const script = join(cwd, `${role}-exact-files-dispatch.ts`)
      writeFileSync(
        script,
        [
          `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
          'const opts = {',
          `  promptFile: ${JSON.stringify(promptFile)},`,
          `  cwd: ${JSON.stringify(cwd)},`,
          `  extraWritableDirs: [${JSON.stringify(reviewWorkDir)}]`,
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

      // The exact hand-off file is still ALLOWED — the existing allowed-file
      // behavior this fix must not regress.
      const allowedPath = join(realpathSync(reviewWorkDir), 'findings.txt')
      const allowed = spawnBudgeted(
        [scriptPath],
        {
          input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: allowedPath } }),
          encoding: 'utf8',
          env: { ...process.env, VINAYA_RUN_ID: runId }
        },
        'write-access hook'
      )
      expect(allowed.status).toBe(0)
      const allowedOut = JSON.parse(allowed.stdout) as { hookSpecificOutput: { permissionDecision: string } }
      expect(allowedOut.hookSpecificOutput.permissionDecision).toBe('allow')

      // A sibling file in the SAME directory, never named by the exact-files
      // allowlist, and a path entirely outside both the real home and the
      // real temp root — both DENIED, for both `Write` and `Edit`.
      const siblingPath = join(reviewWorkDir, 'not-a-handoff-file.txt')
      const outsidePath = '/opt/vinaya-should-never-write-here/x'
      for (const toolName of ['Write', 'Edit']) {
        for (const deniedPath of [siblingPath, outsidePath]) {
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
          expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/hand-off/)
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

  /**
   * Round 4 security review, MEDIUM. A `--agent gemini` dispatch — and a
   * `--agent codex` dispatch of a role that carries no machine-state floor —
   * runs with no permission policy, and says so in its first lifecycle line,
   * so a run log is never indistinguishable from a protected one. A Codex
   * dispatch of a floor-carrying role is the separate case just below: it now
   * DOES carry the machine-state deny list, through Codex's own execpolicy.
   */
  for (const [agent, role] of [
    ['gemini', 'developer'],
    ['codex', 'planner']
  ] as const) {
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

describe('missingSubscriptionLoginReason — O3 (names where Vinaya looked and how to sign in, never an API key)', () => {
  it('claude: names the credential file in the Claude config directory and the sign-in command', () => {
    const reason = missingSubscriptionLoginReason('claude', { CLAUDE_CONFIG_DIR: '/custom/claude' })
    expect(reason).toContain(join('/custom/claude', '.credentials.json'))
    expect(reason).toContain('/login')
  })

  it('claude: falls back to the documented default config directory when the operator overrides nothing', () => {
    expect(missingSubscriptionLoginReason('claude', {})).toContain(join(homedir(), '.claude', '.credentials.json'))
  })

  it('codex: names the login this host holds and the sign-in command', () => {
    const reason = missingSubscriptionLoginReason('codex', { CODEX_HOME: '/custom/codex' })
    expect(reason).toContain(join('/custom/codex', 'auth.json'))
    expect(reason).toContain('credential store')
    expect(reason).toContain('codex login')
  })

  it('O1: no refusal ever asks the operator for an API key, or names one by variable', () => {
    for (const agent of AGENT_VENDOR_NAMES) {
      const reason = missingSubscriptionLoginReason(agent, {})
      expect(reason, `${agent} names a credential variable`).not.toMatch(/[A-Z]+_API_KEY/)
      expect(reason.toLowerCase(), `${agent} asks for a key`).not.toMatch(
        /set .{0,20}api key|api key .{0,20}(required|missing)/
      )
    }
  })

  it('O2: gemini reads as the no-subscription-login refusal, not a missing credential file', () => {
    expect(missingSubscriptionLoginReason('gemini', {})).toBe(NO_SUBSCRIPTION_LOGIN_REASON)
    expect(NO_SUBSCRIPTION_LOGIN_REASON).toContain('no subscription login in Vinaya yet')
  })
})

describe('codexBoundaryFailureReason — round 6 review, MAJOR (Issue #676)', () => {
  it('classifies a preflight refusal as authentication-failed', () => {
    expect(codexBoundaryFailureReason('codex', 'Codex subscription authentication preflight failed: exit 1')).toBe(
      'authentication-failed'
    )
  })

  it('classifies a login-step refusal as authentication-failed too — the same class of "no usable session" failure', () => {
    expect(codexBoundaryFailureReason('codex', 'Codex subscription login failed: exit 1')).toBe('authentication-failed')
  })

  it('classifies a failed plugin install (the Documentation-gate hooks) as hook-setup-failed, never startup-failed or authentication-failed', () => {
    expect(
      codexBoundaryFailureReason(
        'codex',
        'Codex documentation-gate hook install failed: codex plugin install failed (exit 1)'
      )
    ).toBe('hook-setup-failed')
  })

  it('classifies any other boundary refusal reason as startup-failed', () => {
    expect(codexBoundaryFailureReason('codex', 'worker boundary unavailable on this host')).toBe('startup-failed')
  })

  it('never classifies a non-codex vendor as authentication-failed even with a matching-shaped reason string', () => {
    expect(codexBoundaryFailureReason('claude', 'Codex subscription authentication preflight failed: exit 1')).toBe(
      'startup-failed'
    )
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
