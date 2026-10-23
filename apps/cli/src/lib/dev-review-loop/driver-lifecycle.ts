import {
  type DevReviewLoopEventInput,
  isConcludedJournal,
  type LoopState,
  type ReconstructedJournal
} from '@attalabs/aeg-core'
import { appendRoleLine } from '../loop-log.js'
import { errorClassOf } from './round-assess.js'

// What a task driver does around its rounds, shared by the standalone review
// loop and the Engine runner: the liveness heartbeat, the single driver exit
// record, the rule for keeping or clearing the driver lock, and the seeding of
// the round journal from the forge. Each takes every value it needs as an
// explicit parameter, so neither runner has to capture the other's state.

/** The driver's liveness heartbeat interval — one `driver_heartbeat` at most every five minutes while the process is alive, well inside the Log server's own daily write limit for one loop. */
export const DRIVER_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

/**
 * Starts a repeating timer that fires `cb` every `intervalMs`, whose handle is
 * `.unref()`'d so a still-pending timer never keeps the process alive after
 * the driver's own work has returned. The returned function stops it; the exit
 * record calls it before writing any `driver_exited`, so the heartbeat always
 * stops before the exit line.
 */
export function defaultSetHeartbeat(cb: () => void, intervalMs: number): () => void {
  const timer = setInterval(cb, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Where a driver is, as one heartbeat reports it. */
export interface DriverHeartbeatFacts {
  loopId: string
  task: number
  round: number
  /** The phase the driver is in; `null` before its first phase. */
  phase: string | null
  /** The task's pull request, or 0 / negative while there is none. */
  prNumber: number
  log: (event: DevReviewLoopEventInput) => void
}

/**
 * Emits one `driver_heartbeat`. Fire-and-forget: `log` never throws and a
 * failed delivery is dropped like any other event; a build or emit fault is
 * swallowed rather than left to crash the timer or the round.
 */
export function emitDriverHeartbeat(facts: DriverHeartbeatFacts): void {
  try {
    const event: DevReviewLoopEventInput = {
      kind: 'dev_review_loop',
      payload: {},
      loop_id: facts.loopId,
      event: 'driver_heartbeat',
      task: facts.task,
      round: facts.round,
      phase: facts.phase ?? 'starting',
      ...(facts.prNumber > 0 ? { pr: facts.prNumber } : {})
    }
    facts.log(event)
  } catch {
    // A heartbeat is pure telemetry — never a reason to crash the timer
    // or the round. Dropped, exactly like a delivery that fails.
  }
}

/** Why a driver exited. */
export type DriverExitReason = 'finished' | 'paused' | 'reexec' | 'error' | 'signal'

export interface DriverExitRecorderFacts {
  loopId: string
  task: number
  /** The per-task driver log the abnormal exits are traced in. */
  loopLogPath: string
  /** The driver's last decision, read when the exit is recorded. */
  describeDecision: () => string
  /** Stops the heartbeat; called before any exit line is written. */
  stopHeartbeat: () => void
  log: (event: DevReviewLoopEventInput) => void
}

/**
 * Builds the driver's exit recorder. The returned function records the exit
 * once: a second call, from any exit path, does nothing. It stops the
 * heartbeat first, traces an abnormal exit in the per-task driver log, and
 * emits the `driver_exited` Log event.
 */
export function createDriverExitRecorder(
  facts: DriverExitRecorderFacts
): (reason: DriverExitReason, detail?: { exitCode?: number; error?: unknown }) => void {
  let written = false
  return (reason, detail = {}) => {
    if (written) return
    written = true
    facts.stopHeartbeat()
    const describedDecision = facts.describeDecision()
    // The role log stays DIAGNOSTIC, not routine (`apps/cli/specs/loop.md`,
    // "A driver that exits with no decision on record"): only the abnormal
    // exits it has always traced write a line here — a clean `finished`/
    // `paused` return already leaves its decision on the forge and in the
    // control store, so a role-log line there would make the trace routine.
    if (reason !== 'finished' && reason !== 'paused') {
      appendRoleLine(
        facts.loopLogPath,
        'dev-review-loop',
        `driver_exited: reason=${reason} last_decision=${describedDecision}`
      )
    }
    // The Log event, on EVERY exit path — the lifecycle twin of
    // `driver_heartbeat`, so Mission Control can tell a loop that finished or
    // paused from one that is still running or died. Fire-and-forget: `log`
    // never throws and a failed delivery is dropped like any other event.
    // Guarded so a build/emit fault never undoes an exit already in progress.
    try {
      const event: DevReviewLoopEventInput = {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: facts.loopId,
        event: 'driver_exited',
        task: facts.task,
        reason,
        last_decision: describedDecision,
        ...(detail.exitCode !== undefined ? { exit_code: detail.exitCode } : {}),
        ...('error' in detail ? { error_class: errorClassOf(detail.error) } : {})
      }
      facts.log(event)
    } catch {
      // Telemetry — never a reason to crash on the way out.
    }
  }
}

/** How a driver's run ended, as far as the driver lock is concerned. */
export type DriverLockExit =
  | { kind: 'publish' }
  /** A decided pause. `watched` is true under the watching driver, which is never done at any pause. */
  | { kind: 'pause'; reason: string; watched: boolean }
  /** An uncaught error. `hostRepair` is true when the host cannot run the sandbox: that pause frees the lock so an ordinary start can continue once the host is repaired. */
  | { kind: 'crash'; hostRepair: boolean }

/**
 * Whether the driver lock stays in place when the driver exits. An
 * infrastructure or stale-driver pause, an uncaught error and any pause under
 * the watching driver keep it — the run is a live process that hit a
 * recoverable hiccup, and a cleared lock would misrepresent that as a settled
 * pause a person decides. Every other exit — a publish, or any pause that is a
 * decision only a Principal can make — clears it.
 */
export function keepDriverLock(exit: DriverLockExit): boolean {
  switch (exit.kind) {
    case 'publish':
      return false
    case 'crash':
      return !exit.hostRepair
    case 'pause':
      return exit.reason === 'infrastructure' || exit.reason === 'stale_driver' || exit.watched
  }
}

export interface LoopHistorySeed {
  /** The task's round journal as the forge reports it. */
  loopHistory: ReconstructedJournal
  /** Whether the history applies: it has rounds and is not a concluded journal. */
  historyApplies: boolean
  /** The loop state, carrying the history's rounds and totals when the history applies. */
  state: LoopState
}

/**
 * Seeds a loop's state from the round journal rebuilt from the forge markers
 * on the task's own pull request — never a log event or the telemetry outbox.
 * A journal that is already concluded does not seed, so a rerun never doubles
 * a round in the published table; one that is not (a crash before a published
 * summary, a reopened pull request) seeds its rounds, so the next round is
 * numbered after the last marker on the forge rather than restarting at one.
 */
export function seedLoopHistory(facts: {
  fetchLoopHistory: (prNumber: number | null) => ReconstructedJournal
  prNumber: number | null
  state: LoopState
}): LoopHistorySeed {
  const loopHistory = facts.fetchLoopHistory(facts.prNumber)
  const newest = loopHistory.rounds[loopHistory.rounds.length - 1]
  const historyApplies = newest !== undefined && !isConcludedJournal(loopHistory)
  if (!historyApplies) return { loopHistory, historyApplies, state: facts.state }
  return {
    loopHistory,
    historyApplies,
    state: {
      ...facts.state,
      rounds: loopHistory.rounds,
      totalWallMs: loopHistory.totalWallMs,
      totalFilesChanged: loopHistory.totalFilesChanged
    }
  }
}
