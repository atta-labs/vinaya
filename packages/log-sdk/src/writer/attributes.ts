import {
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type TimeInput,
  type Tracer,
  TraceFlags,
  trace
} from '@opentelemetry/api'
import type { Logger } from '@opentelemetry/api-logs'
import {
  ALL_ATTRIBUTE_NAMES,
  ALL_EVENT_NAMES,
  ATTRIBUTE_NAMES,
  FORBIDDEN_CONTENT_ATTRIBUTES,
  isSpanName,
  type RecordProvenance,
  type RecordTrust
} from '../contract/catalogue.js'
import { redact } from '../contract/redact.js'
import type { CustomFieldValue } from '../contract/custom.js'
import { type RunIdGenerator, type SpanParent, spanIdFor } from '../contract/ids.js'

export type AttributeValue = string | number | boolean | string[] | boolean[] | undefined
export type Attrs = Record<string, AttributeValue>

type OpenSpan = { span: Span; ref: SpanParent }

/** The work a run is for; each part is carried on every record once it is named. */
export type Work = {
  ref?: string | undefined
  title?: string | undefined
  change?: string | undefined
  commit?: string | undefined
}

/** The versions of what the run was given; each is carried on every record once it is named. */
export type InputVersions = {
  brief?: string | number | undefined
  objectives?: string | number | undefined
  ruling?: string | number | undefined
  policy?: string | number | undefined
}

/** What the handle knows about the moment: the open round, the open agent's seat, the run's last stage. */
export type Moment = { round?: number; seat?: string; stage?: string }

/** The writer's shared state: one per `connect()`, handed to every writing function. */
export type WriterCore = {
  readonly enabled: boolean
  readonly runId: string
  readonly traceId: string
  readonly writerId: string
  readonly provenance: RecordProvenance
  readonly trust: RecordTrust
  readonly work: Work
  readonly inputs: InputVersions
  readonly moment: Moment
  /** The handle's clock, in milliseconds; the time of the last record written is kept in `lastWrite`. */
  readonly now: () => number
  lastWrite: number
  readonly home: string
  readonly idGenerator: RunIdGenerator
  readonly tracer: Tracer | undefined
  readonly logger: Logger | undefined
  readonly open: Map<string, OpenSpan>
  readonly current: { run?: SpanParent; round?: SpanParent; phase?: SpanParent; agent?: SpanParent }
  /** Pauses begun by this handle and not yet resumed, by key. */
  readonly pauses: Map<string, { ref: SpanParent; startTime: TimeInput; round?: number; why?: string }>
  seq: number
  report(error: unknown): void
}

/** Runs `fn`; a throw is reported once through the handle's error callback and `fallback` returned. */
export function guard<T>(core: Pick<WriterCore, 'report'>, fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (e) {
    core.report(e)
    return fallback
  }
}

/** Checks names against the catalogue, drops content attributes and undefined values, redacts strings. */
export function sanitize(
  core: Pick<WriterCore, 'home'>,
  attrs: Attrs
): Record<string, Exclude<AttributeValue, undefined>> {
  const out: Record<string, Exclude<AttributeValue, undefined>> = {}
  for (const [name, value] of Object.entries(attrs)) {
    if (FORBIDDEN_CONTENT_ATTRIBUTES.includes(name)) continue
    if (!ALL_ATTRIBUTE_NAMES.includes(name)) throw new Error(`attribute "${name}" is not in the catalogue`)
    if (value === undefined) continue
    out[name] =
      typeof value === 'string'
        ? redact(value, core.home)
        : Array.isArray(value)
          ? (value.map((v) => (typeof v === 'string' ? redact(v, core.home) : v)) as string[] | boolean[])
          : value
  }
  return out
}

function nextSeq(core: WriterCore): number {
  core.seq += 1
  return core.seq
}

function contextFor(ref: SpanParent | undefined) {
  if (ref === undefined) return ROOT_CONTEXT
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: ref.traceId,
    spanId: ref.spanId,
    traceFlags: TraceFlags.SAMPLED
  })
}

/** What every record carries, filled from the handle's own context and never passed per call. */
function contextStamps(core: WriterCore): Attrs {
  const { work, inputs, moment } = core
  return {
    [ATTRIBUTE_NAMES.writerId]: core.writerId,
    [ATTRIBUTE_NAMES.provenance]: core.provenance,
    [ATTRIBUTE_NAMES.trust]: core.trust,
    [ATTRIBUTE_NAMES.workRef]: work.ref,
    [ATTRIBUTE_NAMES.workTitle]: work.title,
    [ATTRIBUTE_NAMES.workChange]: work.change,
    [ATTRIBUTE_NAMES.workCommit]: work.commit,
    [ATTRIBUTE_NAMES.round]: moment.round,
    [ATTRIBUTE_NAMES.seat]: moment.seat,
    [ATTRIBUTE_NAMES.inputBrief]: inputText(inputs.brief),
    [ATTRIBUTE_NAMES.inputObjectives]: inputText(inputs.objectives),
    [ATTRIBUTE_NAMES.inputRuling]: inputText(inputs.ruling),
    [ATTRIBUTE_NAMES.inputPolicy]: inputText(inputs.policy)
  }
}

function inputText(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value)
}

function stamps(core: WriterCore, seq: number): Attrs {
  core.lastWrite = core.now()
  return { [ATTRIBUTE_NAMES.seq]: seq, ...contextStamps(core) }
}

/** The span a run-level moment belongs to: the run span, whose id every process derives alike. */
export function runSpanRef(core: WriterCore): SpanParent {
  return core.current.run ?? { traceId: core.traceId, spanId: spanIdFor(core.runId, 'run') }
}

/** Emits one named event as an OpenTelemetry log record, stamped with seq, writer id, provenance and event id. */
export function emitEvent(
  core: WriterCore,
  name: string,
  attrs: Attrs,
  ref?: SpanParent,
  time?: TimeInput,
  customFields?: Record<string, CustomFieldValue>
): void {
  if (!core.enabled || core.logger === undefined) return
  if (customFields === undefined && !ALL_EVENT_NAMES.includes(name)) {
    throw new Error(`event "${name}" is not in the catalogue`)
  }
  const own =
    customFields === undefined
      ? sanitize(core, attrs)
      : Object.fromEntries(
          Object.entries(customFields).map(([key, value]) => [
            key,
            typeof value === 'string' ? redact(value, core.home) : value
          ])
        )
  const seq = nextSeq(core)
  const stamped = sanitize(core, { ...stamps(core, seq), [ATTRIBUTE_NAMES.eventId]: `${core.writerId}:${seq}` })
  core.logger.emit({
    eventName: name,
    timestamp: time ?? Date.now(),
    attributes: { ...own, ...stamped },
    context: contextFor(ref)
  })
}

export type StartSpanInput = {
  name: string
  startedEvent: string
  attrs: Attrs
  parent?: SpanParent | undefined
  /** The id the caller supplies for this span. */
  spanId?: string | undefined
  /** A key both processes name alike; the id is derived from the run id and it. */
  key?: string | undefined
  startTime?: TimeInput | undefined
  /** Whether the span's own start also emits its started event. */
  emitStarted?: boolean
}

/** Starts a span through the tracer, the id generator choosing its id, and emits its started event. */
export function startSpan(core: WriterCore, input: StartSpanInput): SpanParent {
  const spanId = input.spanId ?? (input.key !== undefined ? spanIdFor(core.runId, input.key) : undefined)
  if (!core.enabled || core.tracer === undefined) {
    return { traceId: core.traceId, spanId: spanId ?? '0000000000000000' }
  }
  if (!isSpanName(input.name)) throw new Error(`span "${input.name}" is not in the catalogue`)
  const attrs = sanitize(core, { ...contextStamps(core), ...input.attrs })
  core.lastWrite = core.now()
  if (spanId !== undefined) core.idGenerator.useNextSpanId(spanId)
  let span: Span
  try {
    span = core.tracer.startSpan(
      redact(input.name, core.home),
      { attributes: attrs, ...(input.startTime !== undefined ? { startTime: input.startTime } : {}) },
      contextFor(input.parent)
    )
  } finally {
    // A start that failed before consuming the id must not leak it to the next span.
    if (spanId !== undefined) core.idGenerator.useNextSpanId(undefined)
  }
  const ctx = span.spanContext()
  const ref = { traceId: ctx.traceId, spanId: ctx.spanId }
  core.open.set(ref.spanId, { span, ref })
  if (input.emitStarted !== false) {
    emitEvent(core, input.startedEvent, { [ATTRIBUTE_NAMES.runId]: core.runId }, ref, input.startTime)
  }
  return ref
}

/** Stamps the span, then ends it; the sequence number is taken here, so a started event is always lower. */
export function endSpan(
  core: WriterCore,
  ref: SpanParent,
  attrs: Attrs = {},
  endTime?: TimeInput,
  errorType?: string
): void {
  if (!core.enabled) return
  const open = core.open.get(ref.spanId)
  if (open === undefined) throw new Error(`span ${ref.spanId} is not open`)
  core.open.delete(ref.spanId)
  const all = sanitize(core, {
    ...attrs,
    ...stamps(core, nextSeq(core)),
    [ATTRIBUTE_NAMES.errorType]: errorType
  })
  open.span.setAttributes(all)
  if (errorType !== undefined) open.span.setStatus({ code: SpanStatusCode.ERROR })
  open.span.end(endTime)
  for (const k of ['run', 'round', 'phase', 'agent'] as const) {
    if (core.current[k]?.spanId === ref.spanId) {
      delete core.current[k]
      if (k === 'round') delete core.moment.round
      if (k === 'agent') delete core.moment.seat
    }
  }
}

/** Sets attributes on a span that is still open. */
export function setOpenAttributes(core: WriterCore, ref: SpanParent, attrs: Attrs): void {
  if (!core.enabled) return
  const open = core.open.get(ref.spanId)
  if (open === undefined) throw new Error(`span ${ref.spanId} is not open`)
  open.span.setAttributes(sanitize(core, attrs))
}

/** Writes one span whole under a random id: it starts and ends in this call, at the times given or now. */
export function wholeSpan(
  core: WriterCore,
  name: string,
  parent: SpanParent | undefined,
  attrs: Attrs,
  times: { startTime?: TimeInput | undefined; endTime?: TimeInput | undefined; errorType?: string | undefined } = {}
): SpanParent {
  const ref = startSpan(core, {
    name,
    startedEvent: '',
    attrs,
    parent,
    startTime: times.startTime,
    emitStarted: false
  })
  endSpan(core, ref, {}, times.endTime, times.errorType)
  return ref
}
