import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, type RecordProvenance } from '../contract/catalogue.js'

/** An attribute's value as a reader sees it: OTLP's AnyValue read into plain data. A present null (an empty AnyValue) is `null`. */
export type AttributeValue = string | number | boolean | null | AttributeValue[] | { [key: string]: AttributeValue }
export type Attributes = Readonly<Record<string, AttributeValue>>

/** What a record is: a finished span, a span's started event, or any other event. */
export type RecordKind = 'span' | 'started' | 'event'

/**
 * One thing a reader reads, whichever tool wrote it and whichever format it
 * was stored in. Times are OTLP decimal nanoseconds since the epoch, as text.
 */
export type OtelRecord = {
  kind: RecordKind
  traceId: string
  spanId: string
  /** The parent span's id; `null` for a root span and for every event. */
  parentSpanId: string | null
  name: string
  /** A span's start; `null` for an event. */
  startTime: string | null
  /** A span's end, or an event's time. */
  time: string
  attributes: Attributes
  resource: Attributes
  /** The writer's sequence number; `null` when the record carries none. */
  seq: number | null
  writerId: string | null
  /** An event's identity as its writer stamped it; `null` when it states none. */
  eventId: string | null
  provenance: RecordProvenance
  /** The name of the source the record came from. */
  source: string
}

/** The names of the events that start a span, whose span arrives later. */
const STARTED_EVENT_NAMES: ReadonlySet<string> = new Set([
  E.runStarted,
  E.roundStarted,
  E.agentStarted,
  E.stepStarted,
  E.pauseStarted,
  E.personAsked
])

export function isStartedEventName(name: string): boolean {
  return STARTED_EVENT_NAMES.has(name)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyAttributes(): Record<string, AttributeValue> {
  return Object.create(null) as Record<string, AttributeValue>
}

/** One OTLP AnyValue read into plain data. */
export function decodeValue(value: unknown): AttributeValue {
  if (!isObject(value)) return null
  if (typeof value.stringValue === 'string') return value.stringValue
  if (typeof value.boolValue === 'boolean') return value.boolValue
  if (typeof value.intValue === 'string' || typeof value.intValue === 'number') {
    const whole = Number(value.intValue)
    return Number.isSafeInteger(whole) ? whole : String(value.intValue)
  }
  if (typeof value.doubleValue === 'number') return value.doubleValue
  if (typeof value.bytesValue === 'string') return value.bytesValue
  if (isObject(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.map(decodeValue)
  }
  if (isObject(value.kvlistValue) && Array.isArray(value.kvlistValue.values)) {
    return decodeAttributes(value.kvlistValue.values) as { [key: string]: AttributeValue }
  }
  return null
}

/** An OTLP attribute list read into one object; a later entry for a key wins. */
export function decodeAttributes(list: unknown): Attributes {
  const out = emptyAttributes()
  if (!Array.isArray(list)) return out
  for (const entry of list) {
    if (isObject(entry) && typeof entry.key === 'string') out[entry.key] = decodeValue(entry.value)
  }
  return out
}

/** An OTLP time as decimal nanoseconds; an unset or unreadable time is `'0'`. */
export function decodeTime(value: unknown): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString()
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return BigInt(Math.trunc(value)).toString()
  return '0'
}

function hexId(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function stringOf(value: AttributeValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function claimedProvenance(attributes: Attributes): RecordProvenance {
  return attributes[A.provenance] === 'governed' ? 'governed' : 'reported'
}

function stamps(attributes: Attributes) {
  const seq = attributes[A.seq]
  return {
    seq: typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null,
    writerId: stringOf(attributes[A.writerId]),
    eventId: stringOf(attributes[A.eventId]),
    provenance: claimedProvenance(attributes)
  }
}

/** A span read from an OTLP document. Its events are not read here: a span's started event arrives as a record of its own. */
export function decodeSpan(resource: Attributes, span: unknown, source: string): OtelRecord | null {
  if (!isObject(span)) return null
  const attributes = decodeAttributes(span.attributes)
  const parent = hexId(span.parentSpanId)
  return {
    kind: 'span',
    traceId: hexId(span.traceId),
    spanId: hexId(span.spanId),
    parentSpanId: parent === '' ? null : parent,
    name: typeof span.name === 'string' ? span.name : '',
    startTime: decodeTime(span.startTimeUnixNano),
    time: decodeTime(span.endTimeUnixNano),
    attributes,
    resource,
    ...stamps(attributes),
    source
  }
}

/** A log record read from an OTLP document: a started event or any other event. */
export function decodeLog(resource: Attributes, log: unknown, source: string): OtelRecord | null {
  if (!isObject(log)) return null
  const attributes = decodeAttributes(log.attributes)
  const body = isObject(log.body) && typeof log.body.stringValue === 'string' ? log.body.stringValue : ''
  const name =
    typeof log.eventName === 'string' && log.eventName !== ''
      ? log.eventName
      : (stringOf(attributes['event.name']) ?? body)
  const time = decodeTime(log.timeUnixNano)
  return {
    kind: isStartedEventName(name) ? 'started' : 'event',
    traceId: hexId(log.traceId),
    spanId: hexId(log.spanId),
    parentSpanId: null,
    name,
    startTime: null,
    time: time === '0' ? decodeTime(log.observedTimeUnixNano) : time,
    attributes,
    resource,
    ...stamps(attributes),
    source
  }
}

/**
 * The identity a reader drops a second copy by: a span's trace and span id, an
 * event's own identity. A record with neither a span id nor an identity of its
 * own is identified by its name and time, so two such records never collide on
 * empty ids alone.
 */
export function identityOf(record: OtelRecord): string {
  if (record.kind === 'span') {
    return record.spanId === ''
      ? `span::${record.traceId}:${record.name}:${record.startTime}:${record.time}`
      : `span:${record.traceId}:${record.spanId}`
  }
  if (record.eventId !== null) return `${record.kind}:${record.eventId}`
  return `${record.kind}:${record.traceId}:${record.spanId}:${record.name}:${record.time}`
}

/** The key a started event and the span it opens share. */
export function spanKeyOf(record: OtelRecord): string {
  return `${record.traceId}:${record.spanId}`
}
