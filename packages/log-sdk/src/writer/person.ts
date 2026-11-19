import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S } from '../contract/catalogue.js'
import { type SpanParent, spanIdFor } from '../contract/ids.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'
import { writeWholeSpan } from './whole-span.js'

const names = { authority: S.personAuthority, strategy: S.personStrategy, product: S.personProduct }

export type AskPerson = { kind: keyof typeof names; key: string; spanId?: string; startTime: TimeInput }
export type AnswerPerson = {
  kind: keyof typeof names
  spanId: string
  startTime: TimeInput
  endTime?: TimeInput
  by: string
}

export function askPerson(core: WriterCore, detail: AskPerson): SpanParent {
  const ref = { traceId: core.traceId, spanId: detail.spanId ?? spanIdFor(core.runId, detail.key) }
  emitEvent(
    core,
    E.personAsked,
    {
      [A.runId]: core.runId,
      [A.questionKind]: detail.kind,
      [A.questionKey]: detail.key
    },
    ref,
    detail.startTime
  )
  return ref
}

export function answerPerson(core: WriterCore, detail: AnswerPerson): void {
  writeWholeSpan(
    core,
    names[detail.kind],
    { traceId: core.traceId, spanId: detail.spanId },
    runSpanRef(core),
    detail.startTime,
    detail.endTime ?? Date.now(),
    {
      [A.runId]: core.runId,
      [A.questionKind]: detail.kind,
      [A.answeredBy]: detail.by
    }
  )
}
