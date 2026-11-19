import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import { type SpanParent, spanIdFor } from '../contract/ids.js'
import {
  emitEvent,
  endSpan,
  type InputVersions,
  runSpanRef,
  startSpan,
  type WriterCore,
  type Work
} from './attributes.js'
import { writeWholeSpan } from './whole-span.js'

export type EndOptions = { errorType?: string; endTime?: TimeInput }

export type StartRun = {
  /** The process that runs the work; the span name carries it. */
  process?: string
  processVersion?: string
  work?: Work
  inputs?: InputVersions
  roundLimit?: number
  /** Each seat and, when known, the model it runs. */
  seats?: readonly { seat: string; model?: string }[]
  /** The run span's id, when the caller already holds one. */
  spanId?: string
  /** Defaults to `run`, so every process given the run id derives the same run span id. */
  key?: string
  startTime?: TimeInput
}

export type EndRun = {
  rounds?: number
  totalMs?: number
  timeToGreenMs?: number
  filesChanged?: number
  outcome?: 'ready' | 'stopped'
  errorType?: string
  endTime?: TimeInput
}

/** The stages the table lists; any other value is recorded as given. */
export type Stage =
  | (string & {})
  | 'develop'
  | 'local_checks'
  | 'review'
  | 'ready_push'
  | 'focused_checks'
  | 'change_opened'
  | 'waiting_on_ci'
  | 'waiting_for_merge'
  | 'paused_for_a_person'

export type StopRule =
  | 'approved'
  | 'round_limit'
  | 'no_progress'
  | 'escalated'
  | 'person_stop'
  | 'confidence'
  | 'fixed_finding_returned'
  | 'same_finding'
  | 'same_failure'
  | 'time_budget'

export type ExitKind = 'finished' | 'paused' | 'restarted' | 'error' | 'signal'

export type Pause = { key?: string; round?: number; why?: string; startTime?: TimeInput }
export type Resume = {
  /** The pause span `paused` returned; with none, the handle's latest open pause. */
  pause?: SpanParent
  by: 'person' | 'run'
  /** What a later process knows of the pause it resumes: when it began, its round and why. */
  startTime?: TimeInput
  round?: number
  why?: string
  endTime?: TimeInput
}

/** The run is the root `invoke_workflow {process}` span. */
export function started(core: WriterCore, options: StartRun = {}): SpanParent {
  for (const key of ['ref', 'title', 'change', 'commit'] as const) {
    const value = options.work?.[key]
    if (value !== undefined) core.work[key] = value
  }
  for (const key of ['brief', 'objectives', 'ruling', 'policy'] as const) {
    const value = options.inputs?.[key]
    if (value !== undefined) core.inputs[key] = value
  }
  const seats = options.seats
  const modelled = seats?.filter((s) => s.model !== undefined)
  const ref = startSpan(core, {
    name: spanName(S.run, options.process),
    startedEvent: E.runStarted,
    attrs: {
      [A.operationName]: 'invoke_workflow',
      [A.runId]: core.runId,
      [A.processName]: options.process,
      [A.processVersion]: options.processVersion,
      [A.roundLimit]: options.roundLimit,
      [A.runSeats]: seats?.map((s) => s.seat),
      [A.runSeatModels]:
        modelled === undefined || modelled.length === 0 ? undefined : modelled.map((s) => `${s.seat}=${s.model}`)
    },
    spanId: options.spanId,
    key: options.spanId === undefined ? (options.key ?? 'run') : undefined,
    startTime: options.startTime
  })
  core.current.run = ref
  return ref
}

export function ended(core: WriterCore, options: EndRun = {}): void {
  const ref = core.current.run
  if (ref === undefined) throw new Error('no run is open')
  endSpan(
    core,
    ref,
    {
      [A.runRounds]: options.rounds,
      [A.runTotalMs]: options.totalMs,
      [A.runTimeToGreenMs]: options.timeToGreenMs,
      [A.runFilesChanged]: options.filesChanged,
      [A.runOutcome]: options.outcome
    },
    options.endTime,
    options.errorType
  )
}

/** The run is alive: the open round and phase, as an event on the run span. */
export function alive(core: WriterCore): void {
  emitEvent(core, E.alive, { [A.roundNumber]: core.moment.round, [A.phaseName]: core.moment.stage }, runSpanRef(core))
}

export function stageChanged(core: WriterCore, change: { from?: Stage; to: Stage }): void {
  emitEvent(core, E.stageChanged, { [A.stageFrom]: change.from, [A.stageTo]: change.to }, runSpanRef(core))
  core.moment.stage = change.to
}

function pauseKey(round: number | undefined): string {
  return round === undefined ? 'pause' : `pause:round:${round}`
}

/** A paused run is a `vinaya.pause` span under the run; this begins it and the resume ends it, perhaps in a later process. */
export function paused(core: WriterCore, options: Pause = {}): SpanParent {
  const round = options.round ?? core.moment.round
  const ref = { traceId: core.traceId, spanId: spanIdFor(core.runId, options.key ?? pauseKey(round)) }
  const startTime = options.startTime ?? core.now()
  emitEvent(core, E.pauseStarted, { [A.roundNumber]: round, [A.pauseWhy]: options.why }, ref, startTime)
  core.pauses.set(ref.spanId, {
    ref,
    startTime,
    ...(round === undefined ? {} : { round }),
    ...(options.why === undefined ? {} : { why: options.why })
  })
  return ref
}

/** Ends the pause span, whole: its start was taken by `paused`, or is given by a later process. */
export function resumed(core: WriterCore, options: Resume): void {
  const latest = [...core.pauses.values()].at(-1)
  const ref = options.pause ?? latest?.ref
  if (ref === undefined) throw new Error('no pause is open')
  const known = core.pauses.get(ref.spanId)
  const startTime = options.startTime ?? known?.startTime
  if (startTime === undefined) throw new Error('the pause start time is not known')
  core.pauses.delete(ref.spanId)
  writeWholeSpan(core, S.pause, ref, runSpanRef(core), startTime, options.endTime ?? core.now(), {
    [A.roundNumber]: options.round ?? known?.round,
    [A.pauseWhy]: options.why ?? known?.why,
    [A.pauseBy]: options.by
  })
}

export function cancelled(core: WriterCore, detail: { round?: number; by?: string } = {}): void {
  emitEvent(
    core,
    E.cancelled,
    { [A.roundNumber]: detail.round ?? core.moment.round, [A.actor]: detail.by },
    runSpanRef(core)
  )
}

export function retried(core: WriterCore, detail: { failed?: string; tries?: number; recovered?: boolean } = {}): void {
  emitEvent(
    core,
    E.retried,
    { [A.retryFailed]: detail.failed, [A.retryTries]: detail.tries, [A.retryRecovered]: detail.recovered },
    runSpanRef(core)
  )
}

export function stopRuleMet(core: WriterCore, detail: { rule: StopRule }): void {
  emitEvent(core, E.stopRuleMet, { [A.rule]: detail.rule }, runSpanRef(core))
}

export function exited(core: WriterCore, detail: { kind: ExitKind; code?: number; errorType?: string }): void {
  emitEvent(
    core,
    E.exited,
    { [A.exitKind]: detail.kind, [A.exitCode]: detail.code, [A.errorType]: detail.errorType },
    runSpanRef(core)
  )
}

export const HEARTBEAT_MS = 2 * 60 * 1000

/** The timers a handle uses; a test supplies its own, so no real time passes. */
export type Timers = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

export const SYSTEM_TIMERS: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>)
}

/**
 * Sends `alive` whenever the open run has written no record for two minutes.
 * The timer never keeps the process alive and a failure never reaches the caller.
 */
export function createHeartbeat(core: WriterCore, timers: Timers) {
  let timer: unknown
  const stop = (): void => {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = undefined
  }
  const arm = (): void => {
    stop()
    const wait = Math.max(0, HEARTBEAT_MS - (core.now() - core.lastWrite))
    timer = timers.setTimeout(tick, wait)
    const handle = timer as { unref?: () => void } | undefined
    if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') handle.unref()
  }
  function tick(): void {
    timer = undefined
    try {
      if (core.current.run === undefined) return
      if (core.now() - core.lastWrite >= HEARTBEAT_MS) alive(core)
      arm()
    } catch (e) {
      core.report(e)
    }
  }
  return {
    start(): void {
      core.lastWrite = core.now()
      arm()
    },
    stop
  }
}
