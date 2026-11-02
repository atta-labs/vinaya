/**
 * The fixtures the dispatch test files share — vendor stubs, subprocess budgets, the environment strip and the
 * launch-record scan — split out of the one dispatch test file unchanged. Nothing here holds state: each test
 * file keeps its own temporary-directory list and its own cleanup hook.
 */

import { expect, it } from 'bun:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'
import {
  openOutputTee,
  timeoutWarningLeadMs,
  getProcessSnapshot,
  matchesCapturedIdentity
} from '../../../loops/dev-review/dispatch/dispatch.js'

export const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'apps', 'cli')
export const INDEX = join(CLI_ROOT, 'src', 'index.ts')

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
export function pathWithoutRealVendors(): string {
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
export type LaunchedChild = { pid: number; childStartedAt: string | null; childCommand: string | null }

export function collectLaunchedChildren(dir: string): LaunchedChild[] {
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
export function killLaunchedChild(child: LaunchedChild): void {
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

export type CliResult = { status: number; stdout: string; stderr: string }

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
export function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
export const DISPATCH_SUBPROCESS_BUDGET_MS = 18_000

export function runDispatch(
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
export function runScriptWithBudget(script: string, cwd: string, env: NodeJS.ProcessEnv): void {
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
export function spawnBudgeted(
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

export function writeFakeBinary(dir: string, name: string, script: string): string {
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
export function writeIdentityStableFakeBinary(dir: string, name: string): string {
  return writeFakeBinary(
    dir,
    name,
    `#!${process.execPath}\nprocess.stdin.resume()\nsetTimeout(() => process.exit(0), 30000)\nawait new Promise(() => {})\n`
  )
}

export function outboxLines(home: string, issue: number | 'none'): unknown[] {
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

export const PROMPT_FILE_CONTENT = 'do the thing'

// A Claude dispatch whose stream ends without a usage line records the usage
// its session transcript holds instead, and records unknown only with a reason.
export const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001'

export function transcriptLine(
  id: string,
  input: number,
  output: number,
  cacheCreate: number,
  cacheRead: number
): string {
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

export function plantTranscript(configDir: string, sessionId: string, lines: string[]): string {
  const dir = join(configDir, 'projects', '-some-project')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

/** One argv element per line, preserving argument boundaries. */
export function readArgv(path: string): string[] {
  return readFileSync(path, 'utf8').replace(/\n$/, '').split('\n')
}

/**
 * A Developer dispatch's argv with its turn-result flag pair removed —
 * Claude's `--json-schema <schema>`, Codex's `--output-schema <file>` —
 * asserting the pair was there: every Developer dispatch asks for its turn
 * result as the CLI's native structured output (#1125).
 */
export function withoutTurnResultFlag(argv: string[], flag: '--json-schema' | '--output-schema'): string[] {
  const i = argv.indexOf(flag)
  expect(i).toBeGreaterThanOrEqual(0)
  expect(argv[i + 1]?.length ?? 0).toBeGreaterThan(0)
  return [...argv.slice(0, i), ...argv.slice(i + 2)]
}

export type ResumeVendorFixture = {
  agent: 'claude' | 'codex'
  /** stdout a real first dispatch prints, carrying `synthId` as that vendor's own resume identifier. */
  firstStdout: (synthId: string) => string
  /** The exact argv `dispatchRole` must pass the vendor's binary for a `--resume <id>` dispatch. */
  resumeArgv: (id: string) => string[]
}

export const RESUME_VENDOR_FIXTURES: ResumeVendorFixture[] = [
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
  }
]

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
export function teeDirOf(path: string): string {
  return dirname(path)
}

/**
 * Read a teed file once the expected marker has landed. `createWriteStream`
 * flushes on the event loop, so this awaits between polls — a synchronous spin
 * blocks the very flush it is waiting for.
 */
export async function readWhenReady(path: string, marker: string): Promise<string> {
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
