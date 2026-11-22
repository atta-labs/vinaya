import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
import { errorClassOf, isHandleEvent } from './round-assess.js'

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

/** The round each handle has open, so one round is started on it once. */
const openRounds = new WeakMap<object, number>()

/**
 * Starts `number` as the open round on the run's handle, once per round, so the handle's automatic `run.alive`
 * carries it. A process that carries on a run takes the open round from the copy; this only moves it on.
 */
export function startRoundOnHandle(
  where: { runId: string; repository?: string | undefined },
  number: number,
  options: { recorder?: Pick<ReturnType<typeof runRecorder>, 'handle'>; startingCommit?: string } = {}
): void {
  const log = (options.recorder ?? runRecorder()).handle(where.runId, where.repository)
  if (log === undefined || !Number.isInteger(number) || number < 1) return
  if (openRounds.get(log) === number) return
  openRounds.set(log, number)
  // The round names its own span, so a process that starts the round a run already holds open still writes one span.
  log.round.started({
    number,
    key: `round:${number}`,
    ...(options.startingCommit === undefined || options.startingCommit === ''
      ? {}
      : { startingCommit: options.startingCommit })
  })
}

/** Takes the round off the handle's open rounds once its span ends, so the same number can be opened again. */
function closeRoundOnHandle(log: object): void {
  openRounds.delete(log)
}

/** The runs a pause was written for in this process and not yet resumed: such a run is waiting, not ended. */
const pausedRuns = new Set<string>()

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)
const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const confidenceOf = (e: Record<string, unknown>): { given: boolean; value?: number; reason?: string } => {
  if (e.confidence_unavailable === true) return { given: true }
  const value = numberOf(e.confidence_value)
  if (value === undefined) return { given: false }
  const reason = textOf(e.confidence_reason)
  return { given: true, value, ...(reason === undefined ? {} : { reason }) }
}

type EventFinding = { id?: unknown; severity?: unknown; location?: unknown; policy_treatment?: unknown }
type EventReviewer = { role?: unknown; outcome?: unknown }
const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

/**
 * Writes a run, round, review, gate-read or change event through the run's Log handle, with the function that stands
 * for it: `run.started`, `run.ended`, `run.paused`, `run.resumed`, `run.cancelled`, `run.retried`, `run.stopRuleMet`
 * and `run.exited`; `round.started`, `round.ended` and `phase.ended`; `review.verdicts`, `review.findingsCompared`,
 * `checks.read` and `agent.confidenceStated`; `change.saved`, `change.pushed`, `change.opened`,
 * `change.conflicted` and `change.recovered`. Returns `true` when the event is one of these, and no earlier-format
 * line is then written for it.
 * The handle writes the start once per run, whatever process asks, and a process that did not start a span ends it
 * whole from the start in the run's local copy.
 */
export function writeRunLifecycleEvent(
  event: DevReviewLoopEventInput | { kind?: unknown; event?: unknown },
  where: { runId: string; repository?: string | undefined },
  options: {
    runtimeDir?: () => string
    recorder?: Pick<ReturnType<typeof runRecorder>, 'handle'>
    /** The round the run is in as this process starts or carries it on. */
    round?: number
  } = {}
): boolean {
  if (!isHandleEvent(event)) return false
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
      if (options.round !== undefined) startRoundOnHandle(where, options.round, options)
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
      if (rule !== undefined) log.run.stopRuleMet({ rule: rule as Parameters<typeof log.run.stopRuleMet>[0]['rule'] })
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
    case 'round_started': {
      const number = numberOf(e.round)
      const startingCommit = textOf(e.base_head)
      if (number !== undefined)
        startRoundOnHandle(where, number, {
          ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
          ...(startingCommit === undefined ? {} : { startingCommit })
        })
      break
    }
    case 'round_ended':
      log.round.ended({
        ...(numberOf(e.files_changed) === undefined ? {} : { filesChanged: numberOf(e.files_changed) as number }),
        ...(numberOf(e.insertions) === undefined ? {} : { linesAdded: numberOf(e.insertions) as number }),
        ...(numberOf(e.deletions) === undefined ? {} : { linesRemoved: numberOf(e.deletions) as number }),
        ...(textOf(e.outcome) === undefined ? {} : { outcome: textOf(e.outcome) as string })
      })
      closeRoundOnHandle(log)
      break
    case 'phase_time': {
      const phase = textOf(e.phase)
      if (phase === undefined) break
      const endTime = Date.now()
      log.phase.ended({
        phase,
        ...(textOf(e.step) === undefined ? {} : { step: textOf(e.step) as string }),
        startTime: endTime - Math.max(0, numberOf(e.wall_ms) ?? 0),
        endTime
      })
      break
    }
    case 'gate_result_read': {
      log.checks.read({ ...(round === undefined ? {} : { round }), green: e.green === true })
      const confidence = confidenceOf(e)
      if (confidence.given)
        log.agent.confidenceStated({
          ...(confidence.value === undefined ? {} : { confidence: confidence.value }),
          ...(confidence.reason === undefined ? {} : { reason: confidence.reason }),
          afterExtraTurn: e.extra_turn_spent === true
        })
      break
    }
    case 'verdicts_read': {
      const reviewers = (Array.isArray(e.reviewers) ? e.reviewers : []) as EventReviewer[]
      const findings = (Array.isArray(e.findings) ? e.findings : []) as EventFinding[]
      log.review.verdicts({
        seats: reviewers.map((r) => ({ seat: String(r.role ?? ''), verdict: String(r.outcome ?? '') })),
        blockingCount: numberOf(e.blockers) ?? 0,
        findings: findings.map((f) => ({
          id: String(f.id ?? ''),
          severity: String(f.severity ?? ''),
          place: String(f.location ?? ''),
          blocking: f.policy_treatment === 'blocking'
        }))
      })
      break
    }
    case 'findings_compared':
      log.review.findingsCompared({
        open: listOf(e.open),
        resolved: listOf(e.resolved),
        new: listOf(e.new),
        recurring: listOf(e.recurring)
      })
      break
    case 'storage_push':
      log.change.saved({
        ...(textOf(e.branch) === undefined ? {} : { branch: textOf(e.branch) as string }),
        ...(textOf(e.head) === undefined ? {} : { commit: textOf(e.head) as string })
      })
      break
    case 'ready_push':
      log.change.pushed({
        result: e.outcome === 'refused' ? 'refused' : 'passed',
        ...(numberOf(e.selected) === undefined ? {} : { picked: numberOf(e.selected) as number }),
        ...(numberOf(e.failed) === undefined ? {} : { failed: numberOf(e.failed) as number }),
        ...(numberOf(e.wall_ms) === undefined ? {} : { ms: numberOf(e.wall_ms) as number })
      })
      break
    case 'pr_opened':
      if (numberOf(e.pr) !== undefined)
        log.change.opened({
          change: String(numberOf(e.pr)),
          ...(textOf(e.head) === undefined ? {} : { commit: textOf(e.head) as string })
        })
      break
    case 'conflict_reentry':
      log.change.conflicted({
        ...(numberOf(e.attempt) === undefined ? {} : { reentry: numberOf(e.attempt) as number })
      })
      break
    case 'unpushed_work_resume':
      log.change.recovered()
      break
    case 'driver_exited': {
      const kind = EXIT_KINDS[String(e.reason)]
      if (kind === undefined) break
      log.run.exited({
        kind,
        ...(numberOf(e.exit_code) === undefined ? {} : { code: numberOf(e.exit_code) as number }),
        ...(textOf(e.error_class) === undefined ? {} : { errorType: textOf(e.error_class) as string })
      })
      // A finished run is over: the next run of the task is a new one, not a carry-on of this id.
      if (kind === 'finished') forget()
      break
    }
  }
  return true
}

/** When and by whom the forge says a pull request was merged or closed; each part the forge does not name is absent. */
export interface ForgeChangeEnd {
  when?: number
  by?: string
}

/**
 * Reads, from the forge, when a pull request the run watches was merged or closed, and who merged it; the forge names
 * no closer, so a close carries a time alone. Reads the run's own repository when it is known, within a time bound.
 * Never throws.
 */
export function readForgeChangeEnd(pr: number, repository?: string): ForgeChangeEnd {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', String(pr), ...(repository ? ['--repo', repository] : []), '--json', 'mergedAt,closedAt,mergedBy'],
      {
        timeout: 15_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    const read = JSON.parse(out) as {
      mergedAt?: string | null
      closedAt?: string | null
      mergedBy?: { login?: string } | null
    }
    const at = Date.parse(read.mergedAt ?? read.closedAt ?? '')
    return {
      ...(Number.isFinite(at) ? { when: at } : {}),
      ...(read.mergedBy?.login ? { by: read.mergedBy.login } : {})
    }
  } catch {
    return {}
  }
}

/** The pull requests whose end this process wrote, by run: a watch that reads the same end twice writes it once. */
const writtenEnds = new Set<string>()

/**
 * Records a pull request the run watches as merged (`log.change.merged`) or closed without merging
 * (`log.change.closed`), written on the run's own Log handle and linked to the run's trace. It is called only from
 * the run's own watch of its pull request, whether the run is waiting for the merge or paused. The run is the one
 * this process names (`VINAYA_RUN_ID`, set by both runners) or the task's kept run; a process that can name none
 * writes nothing, since a merge linked to no run is not a record of the run.
 */
export function recordWatchedChangeEnded(
  ended: { state: 'merged' | 'closed'; task: number; pr: number },
  options: {
    runId?: string
    repository?: string
    runtimeDir?: () => string
    recorder?: Pick<ReturnType<typeof runRecorder>, 'handle'>
    readEnd?: (pr: number) => ForgeChangeEnd
  } = {}
): void {
  try {
    let runId = options.runId ?? (process.env.VINAYA_RUN_ID || undefined)
    if (runId === undefined) {
      try {
        const path = runIdPath((options.runtimeDir ?? runtimeDirForThisRepo)(), ended.task)
        if (existsSync(path)) runId = readFileSync(path, 'utf8').trim() || undefined
      } catch {
        // No kept run: nothing to link to.
      }
    }
    if (runId === undefined) return
    const key = `${runId}\0${ended.pr}\0${ended.state}`
    if (writtenEnds.has(key)) return
    const log = (options.recorder ?? runRecorder()).handle(runId, options.repository)
    if (log === undefined) return
    writtenEnds.add(key)
    const end = (options.readEnd ?? ((pr) => readForgeChangeEnd(pr, options.repository)))(ended.pr)
    const detail = {
      runId,
      ...(end.when === undefined ? {} : { when: end.when }),
      ...(end.by === undefined ? {} : { by: end.by })
    }
    if (ended.state === 'merged') log.change.merged(detail)
    else log.change.closed(detail)
  } catch {
    // The record of an end is never a reason to fail the watch that saw it.
  }
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
    // The Log event, on EVERY exit path, written as `run.exited` on the run's Log handle so a reader can tell a loop
    // that finished or paused from one that is still running or died. Fire-and-forget: `log`
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
