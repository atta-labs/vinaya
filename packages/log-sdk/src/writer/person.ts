import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import { CUSTOM_TEXT_MAX_LENGTH } from '../contract/custom.js'
import { type SpanParent, spanIdFor } from '../contract/ids.js'
import { redact } from '../contract/redact.js'
import { timeInput } from '../reader/span-start.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'
import { findOpenStart } from './carried.js'
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
  /** How to answer, as short text a loop fills, for example the command to run. */
  howToAnswer?: string
  spanId?: string
  startTime: TimeInput
}

export type PersonAnswered = {
  kind: PersonKind
  spanId: string
  /** When the question was asked; with none, this handle's own question or the one in the run's local copy. */
  startTime?: TimeInput
  endTime?: TimeInput
  /** The answer, as a short code. */
  answer?: string
  /** Who gave it. */
  by: string
  /** What a later process knows of the question it answers. */
  why?: string
  decision?: string
  howToAnswer?: string
}

type Asked = { startTime: TimeInput; why?: string; decision?: string; howToAnswer?: string }

/** What this handle asked, by span id, so its own answer carries the question's start, why and decision. */
const asks = new WeakMap<WriterCore, Map<string, Asked>>()

/** The how-to-answer text, redacted like every string, then cut to the text cap. */
function howTo(core: WriterCore, text: string | undefined): string | undefined {
  return text === undefined ? undefined : redact(text, core.home).slice(0, CUSTOM_TEXT_MAX_LENGTH)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The question to a person is a `vinaya.person {kind}` span; this begins it and the answer ends it. */
export function asked(core: WriterCore, detail: PersonAsked): SpanParent {
  const ref = { traceId: core.traceId, spanId: detail.spanId ?? spanIdFor(core.runId, detail.key) }
  const own = asks.get(core) ?? new Map<string, Asked>()
  asks.set(core, own)
  const howToAnswer = howTo(core, detail.howToAnswer)
  own.set(ref.spanId, {
    startTime: detail.startTime,
    ...(detail.why === undefined ? {} : { why: detail.why }),
    ...(detail.decision === undefined ? {} : { decision: detail.decision }),
    ...(howToAnswer === undefined ? {} : { howToAnswer })
  })
  emitEvent(
    core,
    E.personAsked,
    {
      [A.runId]: core.runId,
      [A.questionKind]: detail.kind,
      [A.questionKey]: detail.key,
      [A.personWhy]: detail.why,
      [A.personDecision]: detail.decision,
      [A.personHowToAnswer]: howToAnswer
    },
    ref,
    detail.startTime
  )
  return ref
}

export function answered(core: WriterCore, detail: PersonAnswered): void {
  const own = asks.get(core)?.get(detail.spanId)
  asks.get(core)?.delete(detail.spanId)
  // A question another process asked is found in the run's local copy.
  const found =
    own === undefined && core.enabled
      ? findOpenStart(core, E.personAsked, (r) => r.spanId === detail.spanId)
      : undefined
  const known: Partial<Asked> | undefined =
    own ??
    (found === undefined
      ? undefined
      : {
          startTime: timeInput(found.time),
          ...(text(found.attributes[A.personWhy]) === undefined ? {} : { why: text(found.attributes[A.personWhy]) }),
          ...(text(found.attributes[A.personDecision]) === undefined
            ? {}
            : { decision: text(found.attributes[A.personDecision]) }),
          ...(text(found.attributes[A.personHowToAnswer]) === undefined
            ? {}
            : { howToAnswer: text(found.attributes[A.personHowToAnswer]) })
        })
  const startTime = detail.startTime ?? known?.startTime
  if (startTime === undefined) throw new Error('the person question start time is not known')
  writeWholeSpan(
    core,
    spanName(S.person, detail.kind),
    { traceId: core.traceId, spanId: detail.spanId },
    runSpanRef(core),
    startTime,
    detail.endTime ?? core.now(),
    {
      [A.runId]: core.runId,
      [A.questionKind]: detail.kind,
      [A.personWhy]: detail.why ?? known?.why,
      [A.personDecision]: detail.decision ?? known?.decision,
      [A.personHowToAnswer]: howTo(core, detail.howToAnswer) ?? known?.howToAnswer,
      [A.personAnswer]: detail.answer,
      [A.answeredBy]: detail.by
    }
  )
}
