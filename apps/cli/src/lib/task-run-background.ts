/**
 * `vinaya task run --background` — Part 1 (O1): a background start that
 * returns a durable run handle only after the control store has recorded
 * controller ownership of the task, never before. Part 2 (O2): the actual
 * controller runs detached from this process, in its own process group,
 * with its output routed to the same per-task loop log `vinaya task status
 * --follow` already tails — so `task status` finds it, and closing the
 * client conversation that called this function never terminates it. Part 3
 * (O3): a restart reconciles a prior launch through the SAME process-
 * identity primitives `apps/cli/src/lib/dispatch.ts` already built for role
 * launches, fences any effect left `'started'` by a controller that never
 * confirmed it (`fenceStartedEffectsAsUncertain`), and refuses before ever
 * spawning anything on a host this driver cannot supervise.
 *
 * This does not make `runTask` itself detach (Traps to avoid: foreground
 * behavior is unchanged, and `dev-review-loop.ts` is out of this task's
 * Surface). It spawns a second OS process running the exact same CLI
 * (`process.argv[0]`/`[1]`, the same self-reinvocation `dev-review-loop.ts`'s
 * own `defaultReexecSelf` already uses for a stale-driver re-exec) with
 * `--issue <task> --agent <vendor>` — that child does everything `task run`
 * always did, including its own preparation and its own one-driver-per-task
 * pid lock; this file's only job is to acknowledge, durably, that the child
 * was launched to own this task before telling the caller it may disconnect.
 *
 * One background run slot per task, not per request: unlike `task_start`'s
 * per-request idempotency (`task-tools/start.ts`), a second `--background`
 * call against a task that already has a LIVE controller attaches to that
 * SAME run (O2's "reattachment reads the same run rather than starting
 * another") instead of racing a second one.
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { dirname } from 'node:path'
import { resolveRepo as realResolveRepo } from '@attalabs/aeg-forge-state'
import {
  acquireOwnership,
  appendTransition,
  type ControlStoreDeps,
  defaultControlStoreDeps,
  defaultIsPidAlive,
  readCurrentOwnership,
  readRun,
  type RunRecord,
  writeInput,
  writeRun
} from '@attalabs/aeg-core'
import { controlStoreRoot } from './effects.js'
import {
  type AgentVendor,
  captureSettledChildSnapshot,
  getProcessSnapshot,
  matchesCapturedIdentity,
  type ProcessSnapshot,
  terminateChildWithGrace
} from './dispatch.js'
import { fenceStartedEffectsAsUncertain } from './dev-review-loop/pause-resume.js'
import { loopLogPathFor } from './loop-log.js'
import { defaultRunTaskDeps, resolveIssueForRunTask, type RunTaskInput } from './task-run.js'

/** `bg-<task>-<epoch>` — a single path-safe segment (`control-store/local.ts`'s `SAFE_ID_SEGMENT`), unique per epoch so a restart's fresh `writeRun` never collides with a prior, now-stale attempt's own record. */
function runIdFor(task: number, epoch: number): string {
  return `bg-${task}-${epoch}`
}

export type BackgroundRunHandle = {
  task: number
  runId: string
  epoch: number
  pid: number
  host: string
  startedAt: string
  logPath: string
}

/** Refused before launch (O3) — a host this driver cannot supervise, named so a caller reads a refusal rather than a silent hang or an orphaned child. */
export class BackgroundUnsupportedError extends Error {}

/** A live controller for this task is recorded on a DIFFERENT host, or a genuinely concurrent starter won the race for the next epoch — never silently taken over. */
export class ControllerConflictError extends Error {
  constructor(
    readonly task: number,
    readonly host: string
  ) {
    super(
      `task ${task} already has a controller recorded on host '${host}' — reattach with \`vinaya task status\` from that host rather than starting a second one here.`
    )
    this.name = 'ControllerConflictError'
  }
}

/** The task's current control-store epoch and the `run` record written for it, or `null` when no epoch has ever been acquired for this task, or one was acquired but no `run` was ever durably recorded against it (a launch that failed before reaching `writeRun`, below — nothing live to reconcile). */
export type BackgroundControllerRun = { epoch: number; run: RunRecord }

export function readCurrentControllerRun(
  task: number,
  deps: Pick<ControlStoreDeps, 'root'>
): BackgroundControllerRun | null {
  const current = readCurrentOwnership(deps, task)
  if (current.epoch === 0) return null
  const runRead = readRun(deps, task, runIdFor(task, current.epoch))
  if (runRead.status !== 'ok') return null
  return { epoch: current.epoch, run: runRead.value }
}

export type BackgroundLivenessDeps = Pick<ControlStoreDeps, 'hostname'> & {
  isPidAlive: (pid: number) => boolean
  getProcessSnapshot: (pid: number) => ProcessSnapshot | null
  matchesCapturedIdentity: (
    record: { childStartedAt: string | null; childCommand: string | null },
    snapshot: ProcessSnapshot
  ) => boolean
}

export type BackgroundLiveness = 'live' | 'gone' | 'other-host'

/**
 * `'other-host'` — recorded owner is a different machine; this process
 * cannot verify liveness locally and must never claim to. `'gone'` — same
 * host, but the pid no longer answers a liveness probe, or it does but its
 * captured start-time/command no longer match (the pid was recycled) — a
 * genuine restart-after-crash, safe to reconcile. `'live'` — the exact
 * process this record was written for is still running.
 */
export function classifyBackgroundControllerLiveness(run: RunRecord, deps: BackgroundLivenessDeps): BackgroundLiveness {
  if (run.host !== deps.hostname()) return 'other-host'
  if (!deps.isPidAlive(run.pid)) return 'gone'
  const snapshot = deps.getProcessSnapshot(run.pid)
  if (!snapshot) return 'gone'
  const identity = { childStartedAt: run.childStartedAt ?? null, childCommand: run.childCommand ?? null }
  return deps.matchesCapturedIdentity(identity, snapshot) ? 'live' : 'gone'
}

function defaultBackgroundLivenessDeps(): Pick<ControlStoreDeps, 'root' | 'hostname'> & BackgroundLivenessDeps {
  return {
    root: controlStoreRoot,
    hostname: () => osHostname(),
    isPidAlive: defaultIsPidAlive,
    getProcessSnapshot,
    matchesCapturedIdentity
  }
}

export type LiveBackgroundController = { pid: number; startedAt: string; epoch: number }

/**
 * The strong, `ps`-backed liveness read — reserved for the LAUNCH-time
 * reconciliation inside `startBackgroundRun`, below, where mistaking a
 * recycled pid for the same live controller risks a genuine double-launch.
 * Never called from `task-status.ts`: that file's own module doc states a
 * deliberate trap ("never a `ps` scan") this function's `getProcessSnapshot`
 * dependency would violate — `findRecordedControllerRun`, below, is what
 * `task-status.ts` actually reads.
 */
export function findLiveBackgroundController(
  task: number,
  deps: Pick<ControlStoreDeps, 'root' | 'hostname'> & BackgroundLivenessDeps = defaultBackgroundLivenessDeps()
): LiveBackgroundController | null {
  const controller = readCurrentControllerRun(task, deps)
  if (!controller) return null
  if (classifyBackgroundControllerLiveness(controller.run, deps) !== 'live') return null
  return { pid: controller.run.pid, startedAt: controller.run.startedAt, epoch: controller.epoch }
}

export type RecordedBackgroundController = { pid: number; startedAt: string }

/**
 * `vinaya task status`'s own read (O2, "task status attaches by run
 * identity"): a background controller reported here even in the brief
 * window between this file's own launch and the detached child's own
 * `devReviewLoop` reaching its unrelated, pre-existing `driver.pid.json`
 * lock — `task-status.ts` checks this ONLY as a fallback once that legacy
 * lock reads absent or dead, so once the child's own lock is live, that
 * check (unchanged) keeps winning, exactly as before this task. Trusts a
 * same-host, signal-0 pid-liveness probe alone — the SAME weaker guarantee
 * `deriveLoopState`'s own legacy-lock check already accepts (no process-
 * identity verification, so a since-recycled pid could in principle be
 * misread as still this run) — deliberately, to honor `task-status.ts`'s own
 * "never a `ps` scan" trap: a status glance across every open task is not
 * the place to pay `getProcessSnapshot`'s per-pid `ps` cost, and this file's
 * own launch-time reconciliation (`findLiveBackgroundController`, above)
 * is what actually needs — and gets — the stronger check.
 */
export function findRecordedControllerRun(
  task: number,
  deps: Pick<ControlStoreDeps, 'root' | 'hostname'> & Pick<BackgroundLivenessDeps, 'isPidAlive'> = {
    root: controlStoreRoot,
    hostname: () => osHostname(),
    isPidAlive: defaultIsPidAlive
  }
): RecordedBackgroundController | null {
  const controller = readCurrentControllerRun(task, deps)
  if (!controller) return null
  if (controller.run.host !== deps.hostname()) return null
  if (!deps.isPidAlive(controller.run.pid)) return null
  return { pid: controller.run.pid, startedAt: controller.run.startedAt }
}

function handleFromRun(run: RunRecord, epoch: number, logPath: string): BackgroundRunHandle {
  return { task: run.task, runId: run.runId, epoch, pid: run.pid, host: run.host, startedAt: run.startedAt, logPath }
}

/**
 * O3: refused before anything is launched, on a host this driver cannot
 * supervise. Detachment here relies on POSIX process-group semantics
 * (`detached: true` making the child its own process-group leader — the
 * same mechanism `apps/cli/src/checks/runner.ts`'s own group-kill launcher
 * already uses) and the system `ps` (`dispatch.ts`'s `getProcessSnapshot`,
 * "every supported platform ships one" — true for macOS/Linux, not for
 * Windows). Traps to avoid: this must expose the gap rather than detach and
 * hope, so the refusal is loud and pre-launch, never a silent degrade.
 */
export function checkHostSupervisionCapability(): { supported: true } | { supported: false; reason: string } {
  if (process.platform === 'win32') {
    return {
      supported: false,
      reason:
        "background supervision requires POSIX process-group signaling and a 'ps'-based identity read; this host reports platform 'win32', which this driver does not yet support. Run without --background on this host."
    }
  }
  return { supported: true }
}

async function defaultResolveLoopLogPath(task: number): Promise<string> {
  const repo = await realResolveRepo().catch(() => null)
  return loopLogPathFor(repo, task)
}

/** Opens (creating the parent directory as needed) `path` in append mode for a spawned child's `stdio` — closed by the caller immediately after `spawn` returns; the child's own inherited copy of the descriptor stays open regardless (POSIX `fork`/`exec` semantics), so closing ours here never truncates or races the child's writes. */
function openLoopLogAppendFd(path: string): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  return openSync(path, 'a')
}

export type SpawnedController = {
  pid?: number
  unref: () => void
  on: (event: 'error', cb: (err: Error) => void) => void
}

/** `process.argv[0]`/`[1]` re-invoke the exact interpreter and entry script this process itself was started with (the same self-reinvocation `dev-review-loop.ts`'s `defaultReexecSelf` already relies on) — so a background start behaves identically whether the caller ran `bun apps/cli/src/index.ts` from source or a published `vinaya` binary. `detached: true` makes the child the leader of its own process group, surviving this process's own exit; `stdio` routes both the child's stdout and stderr into the SAME per-task loop log `--follow` already tails, so nothing the controller prints is lost once the terminal that started it is gone. */
function defaultSpawnDetached(argv: string[], opts: { stdioFd: number }): SpawnedController {
  return spawn(process.argv[0] as string, [process.argv[1] as string, ...argv], {
    detached: true,
    stdio: ['ignore', opts.stdioFd, opts.stdioFd]
  })
}

export type StartBackgroundRunDeps = {
  resolveIssue: (input: RunTaskInput) => Promise<number>
  controlStore: ControlStoreDeps
  isPidAlive: (pid: number) => boolean
  getProcessSnapshot: (pid: number) => ProcessSnapshot | null
  captureSettledChildSnapshot: (pid: number) => ProcessSnapshot | null
  matchesCapturedIdentity: (
    record: { childStartedAt: string | null; childCommand: string | null },
    snapshot: ProcessSnapshot
  ) => boolean
  terminateChild: (pid: number) => void
  fenceStartedEffects: (task: number, epoch: number) => string[]
  spawnDetached: (argv: string[], opts: { stdioFd: number }) => SpawnedController
  resolveLoopLogPath: (task: number) => Promise<string>
  checkHostSupervisionCapability: () => { supported: true } | { supported: false; reason: string }
}

function defaultStartBackgroundRunDeps(): StartBackgroundRunDeps {
  const controlStore = defaultControlStoreDeps(controlStoreRoot)
  return {
    resolveIssue: (input) => resolveIssueForRunTask(input, defaultRunTaskDeps),
    controlStore,
    isPidAlive: defaultIsPidAlive,
    getProcessSnapshot,
    captureSettledChildSnapshot,
    matchesCapturedIdentity,
    terminateChild: terminateChildWithGrace,
    fenceStartedEffects: (task, epoch) => fenceStartedEffectsAsUncertain(task, epoch, controlStore),
    spawnDetached: defaultSpawnDetached,
    resolveLoopLogPath: defaultResolveLoopLogPath,
    checkHostSupervisionCapability
  }
}

/**
 * O1/O2/O3 — the entire background-start composition:
 *
 * 1. Refuse before touching anything if this host cannot supervise a
 *    detached controller (O3).
 * 2. Resolve the real Issue number (the SAME preparation `runTask` itself
 *    runs — idempotent, since the detached child is about to run it again
 *    on its own).
 * 3. Reconcile any controller already recorded for this task (O3): a LIVE
 *    one on THIS host is attached to (O2) rather than duplicated; one on a
 *    DIFFERENT host refuses rather than guessing; one that is genuinely
 *    gone has its still-`'started'` effect records fenced `'uncertain'`
 *    before this run acquires a fresh epoch, so a late result from the dead
 *    controller can never land silently once a new one owns the task.
 * 4. Acquire the next control-store epoch — losing a genuine race attaches
 *    to whichever run won it, the same O2 treatment as step 3's live case.
 * 5. Spawn the detached child (O2), then write its `run`/`input`/transition
 *    records under the acquired epoch — ownership is "acknowledged," in the
 *    O1 sense, only once this write durably succeeds; a failure here
 *    terminates the child rather than leaving an unacknowledged orphan.
 */
export async function startBackgroundRun(
  input: RunTaskInput,
  deps: StartBackgroundRunDeps = defaultStartBackgroundRunDeps()
): Promise<BackgroundRunHandle> {
  const capability = deps.checkHostSupervisionCapability()
  if (!capability.supported) {
    throw new BackgroundUnsupportedError(`vinaya task run --background: ${capability.reason}`)
  }

  const task = await deps.resolveIssue(input)
  const logPath = await deps.resolveLoopLogPath(task)
  const livenessDeps: BackgroundLivenessDeps = {
    hostname: deps.controlStore.hostname,
    isPidAlive: deps.isPidAlive,
    getProcessSnapshot: deps.getProcessSnapshot,
    matchesCapturedIdentity: deps.matchesCapturedIdentity
  }

  const controller = readCurrentControllerRun(task, deps.controlStore)
  if (controller) {
    const liveness = classifyBackgroundControllerLiveness(controller.run, livenessDeps)
    if (liveness === 'other-host') throw new ControllerConflictError(task, controller.run.host)
    if (liveness === 'live') return handleFromRun(controller.run, controller.epoch, logPath)
    // 'gone' — a genuine restart: this epoch's controller crashed or was
    // killed without confirming its in-flight forge writes. Fence them
    // 'uncertain' before a new epoch is acquired, so a late-arriving result
    // from the dead controller can never be mistaken for confirmed once a
    // new one owns the task (`fenceStartedEffectsAsUncertain`).
    deps.fenceStartedEffects(task, controller.epoch)
  }

  const acquire = acquireOwnership(deps.controlStore, task, `background:${deps.controlStore.hostname()}:${process.pid}`)
  if (!acquire.acquired) {
    // Lost a genuine race against another concurrent starter — attach to
    // whichever run actually won it (O2), rather than failing a caller who
    // did nothing wrong.
    const winner = readRun(deps.controlStore, task, runIdFor(task, acquire.currentEpoch))
    if (winner.status === 'ok') return handleFromRun(winner.value, acquire.currentEpoch, logPath)
    throw new ControllerConflictError(task, acquire.currentOwnerId ?? 'unknown')
  }
  const { epoch } = acquire

  const argv = ['task', 'run', '--issue', String(task), '--agent', input.agent as AgentVendor]
  const fd = openLoopLogAppendFd(logPath)
  let child: SpawnedController
  try {
    child = deps.spawnDetached(argv, { stdioFd: fd })
  } finally {
    closeSync(fd)
  }
  if (!child.pid) {
    throw new Error(`vinaya task run --background: failed to spawn the detached controller for task ${task}`)
  }
  const childPid = child.pid
  // Best-effort: an async spawn failure surfacing after this point cannot
  // un-acknowledge a run already durably recorded below — `task status`
  // will simply find it dead on the next read, the same as any other crash.
  child.on('error', () => {})

  const snapshot = deps.captureSettledChildSnapshot(childPid)
  const runId = runIdFor(task, epoch)
  const nowIso = deps.controlStore.now().toISOString()

  let run: RunRecord
  try {
    run = writeRun(deps.controlStore, task, epoch, {
      runId,
      pid: childPid,
      host: deps.controlStore.hostname(),
      startedAt: nowIso,
      childStartedAt: snapshot?.startedAt ?? null,
      childCommand: snapshot?.command ?? null
    })
    writeInput(deps.controlStore, task, epoch, { runId, source: 'fresh', pr: null, round: 0, recordedAt: nowIso })
    appendTransition(deps.controlStore, task, epoch, {
      from: 'none',
      to: 'running',
      detail: 'background start',
      at: nowIso
    })
  } catch (err) {
    deps.terminateChild(childPid)
    throw err
  }

  child.unref()
  return handleFromRun(run, epoch, logPath)
}
