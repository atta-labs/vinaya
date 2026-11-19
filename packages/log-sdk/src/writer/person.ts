import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import { type SpanParent, spanIdFor } from '../contract/ids.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'
import { writeWholeSpan } from './whole-span.js'

export type PersonKind = 'authority' | 'strategy' | 'product'

export type PersonAsked = {
  kind: PersonKind
  /** Names the question; every process derives the same span id from it. */
  key: string
  /** Why the person is asked, as a short code. */
  why?: string
  /** The decision asked for, as a short code. */
  decision?: string
  spanId?: string
  startTime: TimeInput
}

export type PersonAnswered = {
  kind: PersonKind
  spanId: string
  startTime: TimeInput
  endTime?: TimeInput
  /** The answer, as a short code. */
  answer?: string
  /** Who gave it. */
  by: string
  /** What a later process knows of the question it answers. */
  why?: string
  decision?: string
}

/** What this handle asked, by span id, so its own answer carries the question's why and decision. */
const asks = new WeakMap<WriterCore, Map<string, { why?: string; decision?: string }>>()

/** The question to a person is a `vinaya.person {kind}` span; this begins it and the answer ends it. */
export function asked(core: WriterCore, detail: PersonAsked): SpanParent {
  const ref = { traceId: core.traceId, spanId: detail.spanId ?? spanIdFor(core.runId, detail.key) }
  const own = asks.get(core) ?? new Map<string, { why?: string; decision?: string }>()
  asks.set(core, own)
  own.set(ref.spanId, {
    ...(detail.why === undefined ? {} : { why: detail.why }),
    ...(detail.decision === undefined ? {} : { decision: detail.decision })
  })
  emitEvent(
    core,
    E.personAsked,
    {
      [A.runId]: core.runId,
      [A.questionKind]: detail.kind,
      [A.questionKey]: detail.key,
      [A.personWhy]: detail.why,
      [A.personDecision]: detail.decision
    },
    ref,
    detail.startTime
  )
  return ref
}

export function answered(core: WriterCore, detail: PersonAnswered): void {
  const known = asks.get(core)?.get(detail.spanId)
  asks.get(core)?.delete(detail.spanId)
  writeWholeSpan(
    core,
    spanName(S.person, detail.kind),
    { traceId: core.traceId, spanId: detail.spanId },
    runSpanRef(core),
    detail.startTime,
    detail.endTime ?? core.now(),
    {
      [A.runId]: core.runId,
      [A.questionKind]: detail.kind,
      [A.personWhy]: detail.why ?? known?.why,
      [A.personDecision]: detail.decision ?? known?.decision,
      [A.personAnswer]: detail.answer,
      [A.answeredBy]: detail.by
    }
  )
}
