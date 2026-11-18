import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES, EVENT_NAMES, SPAN_NAMES } from '../contract/catalogue.js'
import type { SpanParent } from '../contract/ids.js'
import { endSpan, runSpanRef, startSpan, type WriterCore } from './attributes.js'
import type { EndOptions } from './run.js'

type SpanIdentity = { spanId?: string; key?: string; startTime?: TimeInput }

export type StartRoundOptions = SpanIdentity & { number: number }
export type StartPhaseOptions = SpanIdentity & { name: string }

/** A round is a `vinaya.round` span under the run. */
export function startRound(core: WriterCore, options: StartRoundOptions): SpanParent {
  const ref = startSpan(core, {
    name: SPAN_NAMES.round,
    startedEvent: EVENT_NAMES.roundStarted,
    attrs: { [ATTRIBUTE_NAMES.roundNumber]: options.number },
    parent: runSpanRef(core),
    spanId: options.spanId,
    key: options.key,
    startTime: options.startTime
  })
  core.current.round = ref
  return ref
}

export function endRound(core: WriterCore, options: EndOptions = {}): void {
  const ref = core.current.round
  if (ref === undefined) throw new Error('no round is open')
  endSpan(core, ref, {}, options.endTime, options.errorType)
}

/** A phase is a `vinaya.phase` span under the current round, else under the run. */
export function startPhase(core: WriterCore, options: StartPhaseOptions): SpanParent {
  const ref = startSpan(core, {
    name: SPAN_NAMES.phase,
    startedEvent: EVENT_NAMES.phaseStarted,
    attrs: { [ATTRIBUTE_NAMES.phaseName]: options.name },
    parent: core.current.round ?? runSpanRef(core),
    spanId: options.spanId,
    key: options.key,
    startTime: options.startTime
  })
  core.current.phase = ref
  return ref
}

export function endPhase(core: WriterCore, options: EndOptions = {}): void {
  const ref = core.current.phase
  if (ref === undefined) throw new Error('no phase is open')
  endSpan(core, ref, {}, options.endTime, options.errorType)
}
