import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES, EVENT_NAMES, SPAN_NAMES } from '../contract/catalogue.js'
import type { SpanParent } from '../contract/ids.js'
import { emitEvent, endSpan, runSpanRef, startSpan, type WriterCore } from './attributes.js'

export type StartRunOptions = {
  /** The run span's id, when the caller already holds one. */
  spanId?: string
  /** Defaults to `run`, so every process given the run id derives the same run span id. */
  key?: string
  startTime?: TimeInput
}

export type EndOptions = { errorType?: string; endTime?: TimeInput }

/** The run is the root `invoke_workflow` span. */
export function startRun(core: WriterCore, options: StartRunOptions = {}): SpanParent {
  const ref = startSpan(core, {
    name: SPAN_NAMES.run,
    startedEvent: EVENT_NAMES.runStarted,
    attrs: { [ATTRIBUTE_NAMES.operationName]: 'invoke_workflow', [ATTRIBUTE_NAMES.runId]: core.runId },
    spanId: options.spanId,
    key: options.spanId === undefined ? (options.key ?? 'run') : undefined,
    startTime: options.startTime
  })
  core.current.run = ref
  return ref
}

export function endRun(core: WriterCore, options: EndOptions = {}): void {
  const ref = core.current.run
  if (ref === undefined) throw new Error('no run is open')
  endSpan(core, ref, {}, options.endTime, options.errorType)
}

/** The run's single moments, each a named event on the run span. */
export function alive(core: WriterCore): void {
  emitEvent(core, EVENT_NAMES.alive, {}, runSpanRef(core))
}

export function stageChanged(core: WriterCore, change: { from?: string; to: string }): void {
  emitEvent(
    core,
    EVENT_NAMES.stageChanged,
    { [ATTRIBUTE_NAMES.stageFrom]: change.from, [ATTRIBUTE_NAMES.stageTo]: change.to },
    runSpanRef(core)
  )
}

export function cancelled(core: WriterCore, detail: { reason?: string } = {}): void {
  emitEvent(core, EVENT_NAMES.cancelled, { [ATTRIBUTE_NAMES.reason]: detail.reason }, runSpanRef(core))
}

export function retried(core: WriterCore, detail: { attempt?: number; reason?: string } = {}): void {
  emitEvent(
    core,
    EVENT_NAMES.retried,
    { [ATTRIBUTE_NAMES.attempt]: detail.attempt, [ATTRIBUTE_NAMES.reason]: detail.reason },
    runSpanRef(core)
  )
}

export function stopRuleMet(core: WriterCore, detail: { rule: string; reason?: string }): void {
  emitEvent(
    core,
    EVENT_NAMES.stopRuleMet,
    { [ATTRIBUTE_NAMES.rule]: detail.rule, [ATTRIBUTE_NAMES.reason]: detail.reason },
    runSpanRef(core)
  )
}

export function exited(core: WriterCore, detail: { code?: number; reason?: string } = {}): void {
  emitEvent(
    core,
    EVENT_NAMES.exited,
    { [ATTRIBUTE_NAMES.exitCode]: detail.code, [ATTRIBUTE_NAMES.reason]: detail.reason },
    runSpanRef(core)
  )
}
