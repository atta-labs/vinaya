import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureRunDir, runPath, runtimeDirForThisRepo } from '../../../../../../kernel/run-paths.js'
import { runRecorder } from '../../../../../../kernel/log/run-recorder.js'
import type { DevReviewLoopEventInput, LoopState } from '../../../../tools/dev-review-policy/types'
import {
  isConcludedJournal,
  type ReconstructedJournal
} from '../../../../tools/dev-review-policy/journal-reconstruction'
import { appendRoleLine } from '../../../../../../kernel/log/client/loop-log.js'
import { errorClassOf, isRunLifecycleEvent } from './round-assess.js'

// What a task driver does around its rounds, shared by the standalone review
// loop and the Engine runner: the run's lifecycle as the run's Log handle
// records it, the single driver exit record, the rule for keeping or clearing
// the driver lock, and the seeding of the round journal from the forge. Each
// takes every value it needs as an explicit parameter, so neither runner has
// to capture the other's state. The run's liveness is the Log handle's own: it
// writes `run.alive` after two minutes with no record, so the driver keeps no
// heartbeat of its own.

/** Where a task's run identity is kept: the id every process that works on the task's run writes its records under. */
function runIdPath(runtimeDir: string, task: number): string {
  return runPath(runtimeDir, task, { area: 'task', file: 'log-run-id' })
}

/**
 * The id the task's run is written under, the same in every process that continues the run (a resumed leg, a
 * `--resume` start, a re-exec, a cancel). The first process to ask names it; the id is kept until the run ends, so
 * a later process carries on the run rather than starting another. It is a name for records, never read to decide
 * anything about the run.
 */
export function taskRunId(runtimeDir: string, task: number, fallback: () => string = () => randomUUID()): string {
  const path = runIdPath(runtimeDir, task)
  try {
    if (existsSync(path)) {
      const kept = readFileSync(path, 'utf8').trim()
      if (kept !== '') return kept
    }
  } catch {
    // An unreadable record names no run: this process names one.
  }
  const named = process.env.VINAYA_RUN_ID || fallback()
  try {
    ensureRunDir(dirname(path), runtimeDir)
    writeFileSync(path, `${named}\n`, { mode: 0o600 })
  } catch {
    // A run identity that cannot be kept is this process's alone.
  }
  return named
}

/** Forgets the task's run identity once its run has ended, so the next run of the task is a new one. */
function forgetTaskRunId(runtimeDir: string, task: number): void {
  try {
    rmSync(runIdPath(runtimeDir, task), { force: true })
  } catch {
    // Nothing to forget.
  }
}

const STOP_RULES: Readonly<Record<string, string>> = {
  green: 'approved',
  max_rounds: 'round_limit',
  no_progress: 'no_progress',
  escalated: 'escalated',
  principal_stop: 'person_stop',
  confidence: 'confidence',
  reappearance: 'fixed_finding_returned',
  repeat_finding: 'same_finding',
  repeat_failure: 'same_failure',
  time_budget: 'time_budget'
}

const EXIT_KINDS: Readonly<Record<string, 'finished' | 'paused' | 'restarted' | 'error' | 'signal'>> = {
  finished: 'finished',
  paused: 'paused',
  reexec: 'restarted',
  error: 'error',
  signal: 'signal'
}

/** The handles this process has started, or carried on, a run on: a process works on a run from one start. */
const startedHandles = new WeakSet<object>()

/** The runs a pause was written for in this process and not yet resumed: such a run is waiting, not ended. */
const pausedRuns = new Set<string>()

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)
const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * Writes a run lifecycle event through the run's Log handle, with the function that stands for it:
 * `run.started`, `run.ended`, `run.paused`, `run.resumed`, `run.cancelled`, `run.retried`, `run.stopRuleMet` and
 * `run.exited`. Returns `true` when the event is one of these, and no earlier-format line is then written for it.
 * The handle writes the start once per run, whatever process asks, and a process that did not start a span ends it
 * whole from the start in the run's local copy.
 */
export function writeRunLifecycleEvent(
  event: DevReviewLoopEventInput | { kind?: unknown; event?: unknown },
  where: { runId: string; repository?: string | undefined },
  options: { runtimeDir?: () => string; recorder?: Pick<ReturnType<typeof runRecorder>, 'handle'> } = {}
): boolean {
  if (!isRunLifecycleEvent(event)) return false
  const e = event as unknown as Record<string, unknown>
  const log = (options.recorder ?? runRecorder()).handle(where.runId, where.repository)
  if (log === undefined) return true
  const round = numberOf(e.round)
  const forget = (): void => {
    const task = numberOf(e.task) ?? Number(process.env.VINAYA_TASK)
    if (Number.isInteger(task) && task > 0) forgetTaskRunId((options.runtimeDir ?? runtimeDirForThisRepo)(), task)
  }
  switch (e.event) {
    case 'loop_started': {
      const policy = (e.policy ?? {}) as {
        max_rounds?: number
        reviewers?: string[]
        models?: Record<string, string>
      }
      const seats = ['developer', ...(policy.reviewers ?? [])].map((seat) => {
        const model = policy.models?.[seat]
        return model === undefined ? { seat } : { seat, model }
      })
      // One start per process: the handle already holds the run this process started or carried on.
      if (startedHandles.has(log)) break
      startedHandles.add(log)
      const title = textOf(e.title)
      const name = process.env.VINAYA_PROCESS_ID
      const version = process.env.VINAYA_PROCESS_VERSION
      log.run.started({
        process: name || 'vinaya-strict',
        ...(version ? { processVersion: version } : {}),
        ...(title === undefined ? {} : { work: { title } }),
        ...(policy.max_rounds === undefined ? {} : { roundLimit: policy.max_rounds }),
        seats
      })
      break
    }
    case 'paused':
      pausedRuns.add(where.runId)
      log.run.paused({
        ...(round === undefined ? {} : { round }),
        why: textOf(e.reason_code) ?? textOf(e.reason) ?? 'paused'
      })
      break
    case 'resumed':
      pausedRuns.delete(where.runId)
      log.run.resumed({ by: e.by === 'principal' ? 'person' : 'run', ...(round === undefined ? {} : { round }) })
      break
    case 'cancelled':
      pausedRuns.delete(where.runId)
      log.run.cancelled({ ...(round === undefined ? {} : { round }), by: 'person' })
      // A cancelled run does not resume: its span ends here.
      log.run.ended({ outcome: 'stopped' })
      forget()
      break
    case 'infrastructure_retry':
      log.run.retried({
        ...(textOf(e.failure_kind) === undefined ? {} : { failed: textOf(e.failure_kind) as string }),
        ...(numberOf(e.attempts) === undefined ? {} : { tries: numberOf(e.attempts) as number }),
        recovered: e.outcome === 'recovered'
      })
      break
    case 'stop_condition_met': {
      const rule = STOP_RULES[String(e.condition)]
      if (rule !== undefined) log.run.stopRuleMet({ rule: rule as 'approved' })
      break
    }
    case 'journal_finalized': {
      // A pause leaves the run open for the leg that resumes it: the run's one span ends with the run.
      if (e.result !== 'merged_ready' && pausedRuns.has(where.runId)) break
      log.run.ended({
        ...(numberOf(e.rounds) === undefined ? {} : { rounds: numberOf(e.rounds) as number }),
        ...(numberOf(e.total_wall_ms) === undefined ? {} : { totalMs: numberOf(e.total_wall_ms) as number }),
        ...(numberOf(e.time_to_green_ms) === undefined
          ? {}
          : { timeToGreenMs: numberOf(e.time_to_green_ms) as number }),
        ...(numberOf(e.files_changed_total) === undefined
          ? {}
          : { filesChanged: numberOf(e.files_changed_total) as number }),
        outcome: e.result === 'merged_ready' ? 'ready' : 'stopped'
      })
      forget()
      break
    }
    case 'driver_exited': {
      const kind = EXIT_KINDS[String(e.reason)]
      if (kind === undefined) break
      log.run.exited({
        kind,
        ...(numberOf(e.exit_code) === undefined ? {} : { code: numberOf(e.exit_code) as number }),
        ...(textOf(e.error_class) === undefined ? {} : { errorType: textOf(e.error_class) as string })
      })
      break
    }
  }
  return true
}

/** One automatic conflict re-entry of a published pull request, as both runners narrate it. */
export interface ConflictReentryFacts {
  loopId: string
  task: number
  prNumber: number
  /** This re-entry's number for the pull request, from 1. */
  attempt: number
  /** The most re-entries the driver makes before it pauses for a person. */
  bound: number
}

/** The `conflict_reentry` Log event for one automatic re-entry. */
export function conflictReentryEvent(facts: ConflictReentryFacts): DevReviewLoopEventInput {
  return {
    kind: 'dev_review_loop',
    payload: {},
    loop_id: facts.loopId,
    event: 'conflict_reentry',
    task: facts.task,
    pr: facts.prNumber,
    attempt: facts.attempt,
    bound: facts.bound
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
  log: (event: DevReviewLoopEventInput) => void
}

/**
 * Builds the driver's exit recorder. The returned function records the exit
 * once: a second call, from any exit path, does nothing. It traces an
 * abnormal exit in the per-task driver log, and
 * emits the `driver_exited` Log event.
 */
export function createDriverExitRecorder(
  facts: DriverExitRecorderFacts
): (reason: DriverExitReason, detail?: { exitCode?: number; error?: unknown }) => void {
  let written = false
  return (reason, detail = {}) => {
    if (written) return
    written = true
    const describedDecision = facts.describeDecision()
    // The role log stays DIAGNOSTIC, not routine (`harness/processes/vinaya-strict/loops/dev-review/loop.md`,
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
    // The Log event, on EVERY exit path — written as `run.exited` on the run's Log handle, so a reader can tell a loop
    // that finished or
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
  /** A publication. `watched` is true under the watching driver, which goes on watching the published pull request until it is merged or closed. */
  | { kind: 'publish'; watched: boolean }
  /** A decided pause. `watched` is true under the watching driver, which is never done at any pause. */
  | { kind: 'pause'; reason: string; watched: boolean }
  /** An uncaught error. `hostRepair` is true when the host cannot run the sandbox: that pause frees the lock so an ordinary start can continue once the host is repaired. */
  | { kind: 'crash'; hostRepair: boolean }

/**
 * Whether the driver lock stays in place when the driver exits. An
 * infrastructure or stale-driver pause, an uncaught error and any pause or
 * publish under the watching driver keep it — the run is a live process that
 * hit a recoverable hiccup, or goes on watching its pull request, and a
 * cleared lock would misrepresent that as a settled task. Every other exit —
 * an unwatched publish, or any pause that is a decision only a Principal can
 * make — clears it.
 */
export function keepDriverLock(exit: DriverLockExit): boolean {
  switch (exit.kind) {
    case 'publish':
      return exit.watched
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
 * on the task's own pull request — never a log event or the telemetry files.
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
