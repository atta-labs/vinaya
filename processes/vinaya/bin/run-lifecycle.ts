import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import {
  compareManifest,
  manifestAsEchoed,
  nextRoundNumber,
  type LoopState,
  type ReconstructedJournal,
  type ReviewInputManifest
} from '@attalabs/aeg-core'
import {
  readRunCheckpoint,
  readRunOutcome,
  runIdentityForRunId,
  type RunIdentity,
  type SpawnedProcessLike,
  type SpawnFn
} from '@atta/executor-agent-spawn'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { resolveDispatchTimeoutMs } from '../../../apps/cli/src/lib/dispatch'
import {
  classifyChildLiveness,
  reconcileLaunch,
  type LaunchReconciliation,
  type ReconcileLaunchDeps
} from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import {
  keepDriverLock,
  seedLoopHistory,
  type DriverLockExit
} from '../../../apps/cli/src/lib/dev-review-loop/driver-lifecycle'
import {
  acquireDriverLockAtomic,
  clearDriverLock,
  isDriverPidAlive,
  readDriverLock,
  writeDriverLock
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import type { HeldCleanVerdict } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import type { ParsedLaunch } from '../../../apps/cli/src/lib/dispatch'
import type { LegExit } from '../executing/log-events'

// What the Engine runner does around a run, apart from the run itself: the one
// driver lock per task, the choice between resuming a checkpoint and starting
// fresh, the recovery reads a re-run makes, the ceilings each role launches
// with, and the reaping of every agent process the run started. Each takes
// what it needs as a parameter, so a test drives it without the forge.

// --- the driver lock ---------------------------------------------------------

export interface LockHolder {
  pid: number
  startedAt: string
}

export type LockResult = { acquired: true; token: string } | { acquired: false; holder: LockHolder; message: string }

export interface LockDeps {
  pid: number
  now: () => Date
  isPidAlive: (pid: number) => boolean
  token: string
  /** Narrates a takeover to the per-task driver log. */
  narrate: (line: string) => void
}

const refusal = (task: number, holder: LockHolder): string =>
  `refuses to start for task ${task} — a driver is already running (pid ${holder.pid}, started ${holder.startedAt})`

/**
 * Takes the task's driver lock for this runner, as the standalone loop does: a live holder refuses the start
 * (and names itself), a dead one is taken over, and the claim itself is an exclusive create.
 */
export function takeDriverLock(root: string, task: number, deps: LockDeps): LockResult {
  const existing = readDriverLock(root, task)
  if (existing && deps.isPidAlive(existing.pid)) {
    return { acquired: false, holder: existing, message: refusal(task, existing) }
  }
  if (existing) {
    deps.narrate(
      `task ${task}'s driver lock names pid ${existing.pid} (started ${existing.startedAt}), which is no longer alive — taking over`
    )
    clearDriverLock(root, task)
  }
  const claim = { pid: deps.pid, startedAt: deps.now().toISOString(), token: deps.token }
  if (!acquireDriverLockAtomic(root, task, claim)) {
    // Lost a genuine race for a lock nobody held a moment ago: a live, different holder wins; anything
    // else is a vanishingly narrow residual this single retry closes.
    const raced = readDriverLock(root, task)
    if (raced && raced.pid !== deps.pid && deps.isPidAlive(raced.pid)) {
      return { acquired: false, holder: raced, message: refusal(task, raced) }
    }
    writeDriverLock(root, task, claim)
  }
  return { acquired: true, token: deps.token }
}

/** Clears the lock unless the one shared rule keeps it for this kind of exit. */
export function releaseDriverLock(root: string, task: number, exit: DriverLockExit): 'kept' | 'cleared' {
  if (keepDriverLock(exit)) return 'kept'
  clearDriverLock(root, task)
  return 'cleared'
}

/** How the driver lock sees a leg's exit: a publish, a decided pause, or a crash. A halt is a pause no one else needs to repair. */
export function lockExitOf(exit: LegExit): DriverLockExit {
  if (exit.reason === 'finished') return { kind: 'publish' }
  if (exit.reason === 'error') return { kind: 'crash', hostRepair: false }
  const decided = /^pause\((.*)\)$/.exec(exit.lastDecision)
  return { kind: 'pause', reason: decided?.[1] ?? 'halt', watched: false }
}

// --- re-run choice -------------------------------------------------------------

/** One run identity per task, so a runner started later finds the checkpoints of the one before it. */
export const runIdentityOfTask = (task: number): RunIdentity => runIdentityForRunId(`engine-task-${task}`)

/** The recorded provenance of the newest checkpoint, when the saver keeps one. */
export interface ProvenanceReader {
  latestProvenance?: (threadId: string) => { revision: string; model: string } | undefined
}

export type StartChoice =
  | { kind: 'fresh'; identity: RunIdentity }
  | { kind: 'resume'; identity: RunIdentity; checkpointRevision: string | undefined }
  /** The checkpoint records a run that already completed: there is nothing to continue. */
  | { kind: 'completed'; identity: RunIdentity }

/** Resumes the task's checkpoint when one exists, and otherwise starts fresh. */
export async function chooseStart(
  checkpointer: BaseCheckpointSaver & ProvenanceReader,
  identity: RunIdentity
): Promise<StartChoice> {
  const checkpoint = await readRunCheckpoint(checkpointer, identity)
  if (!checkpoint) return { kind: 'fresh', identity }
  const recorded = await readRunOutcome(checkpointer, identity)
  if (recorded?.reason === 'completed') return { kind: 'completed', identity }
  return {
    kind: 'resume',
    identity,
    checkpointRevision: checkpointer.latestProvenance?.(identity.threadId)?.revision
  }
}

/** The line a resume appends to the driver log when the code moved since the checkpoint was made; null when it did not. */
export function revisionMovedLine(checkpointRevision: string | undefined, currentRevision: string): string | null {
  if (checkpointRevision === undefined || checkpointRevision === currentRevision) return null
  return `resuming at the next step on revision ${currentRevision}; the checkpoint was made at revision ${checkpointRevision}`
}

// --- recovery --------------------------------------------------------------------

export interface RecoveryDeps {
  /** The task's open pull request number, or null. */
  prNumber: () => number | null
  /** The round journal rebuilt from Principal-authored forge comments and the review-gate verdict. */
  fetchLoopHistory: (prNumber: number | null) => ReconstructedJournal
  /** The loop state the history seeds. */
  loopState: () => LoopState
  /** The recorded prior Developer launch. */
  readLaunch: () => ParsedLaunch
  launchDeps: ReconcileLaunchDeps
  /** The newest held verdict pair that is clean, or null. */
  heldVerdict: () => HeldCleanVerdict | null
  /** The manifest of the head as it stands now; null when it cannot be built. */
  currentManifest: () => ReviewInputManifest | null
  patchIdOf?: (sha: string) => string | null
}

export interface Recovery {
  launch: LaunchReconciliation
  state: LoopState
  /** True when the forge journal has rounds that are not yet concluded, so the next round is numbered after them. */
  historyApplies: boolean
  nextRound: number | null
  /** A held clean verdict still bound to the current head by the manifest comparison. */
  held: HeldCleanVerdict | null
  /** Set when a prior launch forbids another: the runner dispatches nothing. */
  refusal: string | null
}

/** The launch deps a real host reads liveness and identity with. */
export function realLaunchDeps(
  snapshot: ReconcileLaunchDeps['getProcessSnapshot'],
  terminate: ReconcileLaunchDeps['terminateChild']
): ReconcileLaunchDeps {
  return {
    isPidAlive: isDriverPidAlive,
    hostname: () => hostname(),
    getProcessSnapshot: snapshot,
    terminateChild: terminate
  }
}

/**
 * What a re-run reads before it dispatches anything: the prior Developer launch, reconciled; the round journal,
 * rebuilt from the forge; and any held clean verdict that still covers the head. The Vinaya Log is never read.
 */
export function recoverRun(deps: RecoveryDeps): Recovery {
  const parsed = deps.readLaunch()
  // An abandoned child is reaped before the reconciliation, so it never races the worker it hands continuity to.
  if (parsed.status === 'ok' && parsed.record.childPid !== null) {
    if (classifyChildLiveness(parsed.record, deps.launchDeps) === 'orphaned')
      deps.launchDeps.terminateChild(parsed.record.childPid)
  }
  const launch = reconcileLaunch(parsed, { requireContinuity: true }, deps.launchDeps)
  const prNumber = deps.prNumber()
  const seeded = seedLoopHistory({
    fetchLoopHistory: deps.fetchLoopHistory,
    prNumber,
    state: deps.loopState()
  })
  const refusal =
    launch.kind === 'live'
      ? `the Developer's prior launch (pid ${launch.record.childPid}) is still running; a second worker must never race the first`
      : launch.kind === 'pause'
        ? launch.detail
        : null
  let held: HeldCleanVerdict | null = null
  const candidate = refusal === null && prNumber !== null ? deps.heldVerdict() : null
  const current = candidate ? deps.currentManifest() : null
  if (candidate && current && current.headSha !== candidate.head) {
    // A held record written before manifest v2 has no protocol or pause-ruling slots: it is compared in its own legacy mode.
    const comparable: ReviewInputManifest =
      candidate.manifest.manifestVersion === undefined
        ? {
            headSha: current.headSha,
            baseSha: current.baseSha,
            briefHash: current.briefHash,
            objectivesVersion: current.objectivesVersion,
            rulingOrdinal: current.rulingOrdinal,
            policyDigest: current.policyDigest
          }
        : current
    const binding = compareManifest(manifestAsEchoed(candidate.manifest), comparable, deps.patchIdOf)
    if (binding.bound) held = candidate
  }
  return {
    launch,
    state: seeded.state,
    historyApplies: seeded.historyApplies,
    nextRound: seeded.historyApplies ? nextRoundNumber(seeded.loopHistory.rounds) : null,
    held,
    refusal
  }
}

// --- role ceilings ----------------------------------------------------------------

/** The Flow's agent roles and the dispatch role whose ceiling each launches under. */
const CEILING_ROLE = {
  developer: 'developer',
  'code-reviewer': 'code-reviewer',
  'security-reviewer': 'security'
} as const

/** Each Flow role's launch ceiling, as `resolveDispatchTimeoutMs` gives it for the dispatch config. */
export function roleTimeouts(
  config: { timeoutMs?: number; reviewerTimeoutMs?: number } | undefined
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(CEILING_ROLE).map(([role, dispatchRole]) => [role, resolveDispatchTimeoutMs(dispatchRole, config)])
  )
}

// --- no orphaned agent -------------------------------------------------------------

export interface ChildReaper {
  /** Spawns through `base`, each agent as the leader of a process group of its own. */
  spawnFn: SpawnFn
  /** The process groups launched so far. */
  groups: () => readonly number[]
  /** Terminates every launched group that still has a member: the graceful signal, then the forced one after `graceMs`. */
  reap: (graceMs?: number) => Promise<void>
}

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // Already gone.
  }
}

/**
 * Wraps a spawn function so every agent starts in a process group of its own, and records the group. The
 * executor's abort signals only the agent it spawned, so what that agent started would outlive a halted run;
 * `reap` ends the whole group.
 */
export function createChildReaper(
  base: SpawnFn = (command, args, options) =>
    spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as SpawnedProcessLike
): ChildReaper {
  const launched = new Set<number>()
  const spawnFn: SpawnFn = (command, args, options) => {
    const child = base(command, args, { ...options, detached: true } as typeof options)
    const pid = (child as { pid?: unknown }).pid
    if (typeof pid === 'number') launched.add(pid)
    return child
  }
  return {
    spawnFn,
    groups: () => [...launched],
    reap: async (graceMs = 2000) => {
      const live = [...launched].filter(groupAlive)
      for (const pgid of live) signalGroup(pgid, 'SIGTERM')
      const deadline = Date.now() + graceMs
      while (live.some(groupAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      for (const pgid of live) if (groupAlive(pgid)) signalGroup(pgid, 'SIGKILL')
      launched.clear()
    }
  }
}

/** The exit code a shell reports for a process ended by `signal`. */
export const SIGNAL_EXIT_CODE: Readonly<Record<'SIGINT' | 'SIGTERM', number>> = { SIGINT: 130, SIGTERM: 143 }

/**
 * Maps SIGINT and SIGTERM to `onSignal` for as long as the returned function has not been called. The handler is
 * the run's abort: the process keeps running until the run has stopped and its agents have been reaped.
 */
export function onShutdownSignals(onSignal: (signal: 'SIGINT' | 'SIGTERM') => void): () => void {
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => onSignal(signal)
    process.on(signal, handler)
    return [signal, handler] as const
  })
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}
