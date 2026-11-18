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
  ALL_SPAN_NAMES,
  ATTRIBUTE_NAMES,
  FORBIDDEN_CONTENT_ATTRIBUTES,
  type RecordProvenance
} from '../contract/catalogue.js'
import { redact } from '../contract/redact.js'
import { type RunIdGenerator, type SpanParent, spanIdFor } from '../contract/ids.js'

export type AttributeValue = string | number | boolean | string[] | undefined
export type Attrs = Record<string, AttributeValue>

type OpenSpan = { span: Span; ref: SpanParent }

/** The writer's shared state: one per `connect()`, handed to every writing function. */
export type WriterCore = {
  readonly enabled: boolean
  readonly runId: string
  readonly traceId: string
  readonly writerId: string
  readonly provenance: RecordProvenance
  readonly workRef: string | undefined
  readonly home: string
  readonly idGenerator: RunIdGenerator
  readonly tracer: Tracer | undefined
  readonly logger: Logger | undefined
  readonly open: Map<string, OpenSpan>
  readonly current: { run?: SpanParent; round?: SpanParent; phase?: SpanParent; agent?: SpanParent }
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
): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const [name, value] of Object.entries(attrs)) {
    if (FORBIDDEN_CONTENT_ATTRIBUTES.includes(name)) continue
    if (!ALL_ATTRIBUTE_NAMES.includes(name)) throw new Error(`attribute "${name}" is not in the catalogue`)
    if (value === undefined) continue
    out[name] =
      typeof value === 'string'
        ? redact(value, core.home)
        : Array.isArray(value)
          ? value.map((v) => redact(v, core.home))
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

function stamps(core: WriterCore, seq: number): Attrs {
  return {
    [ATTRIBUTE_NAMES.seq]: seq,
    [ATTRIBUTE_NAMES.writerId]: core.writerId,
    [ATTRIBUTE_NAMES.provenance]: core.provenance,
    [ATTRIBUTE_NAMES.workRef]: core.workRef
  }
}

/** The span a run-level moment belongs to: the run span, whose id every process derives alike. */
export function runSpanRef(core: WriterCore): SpanParent {
  return core.current.run ?? { traceId: core.traceId, spanId: spanIdFor(core.runId, 'run') }
}

/** Emits one named event as an OpenTelemetry log record, stamped with seq, writer id, provenance and event id. */
export function emitEvent(core: WriterCore, name: string, attrs: Attrs, ref: SpanParent, time?: TimeInput): void {
  if (!core.enabled || core.logger === undefined) return
  if (!ALL_EVENT_NAMES.includes(name)) throw new Error(`event "${name}" is not in the catalogue`)
  const own = sanitize(core, attrs)
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
  if (!ALL_SPAN_NAMES.includes(input.name)) throw new Error(`span "${input.name}" is not in the catalogue`)
  const attrs = sanitize(core, input.attrs)
  if (spanId !== undefined) core.idGenerator.useNextSpanId(spanId)
  let span: Span
  try {
    span = core.tracer.startSpan(
      input.name,
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
    if (core.current[k]?.spanId === ref.spanId) delete core.current[k]
  }
}

/** Sets attributes on a span that is still open. */
export function setOpenAttributes(core: WriterCore, ref: SpanParent, attrs: Attrs): void {
  if (!core.enabled) return
  const open = core.open.get(ref.spanId)
  if (open === undefined) throw new Error(`span ${ref.spanId} is not open`)
  open.span.setAttributes(sanitize(core, attrs))
}
