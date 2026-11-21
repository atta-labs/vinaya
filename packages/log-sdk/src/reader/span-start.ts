import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A } from '../contract/catalogue.js'
import type { Attrs } from '../writer/attributes.js'
import type { OtelRecord } from './records.js'

/**
 * The one rule for which record is a span's start, shared by the `vinaya-log`
 * command and the handle: a started event whose span has no finished record
 * written at or after it. The latest such event wins.
 */
export function latestOpenStart(
  records: readonly OtelRecord[],
  event: string,
  traceId: string,
  accept: (record: OtelRecord) => boolean = () => true
): OtelRecord | undefined {
  const finished = new Map<string, bigint>()
  for (const record of records) {
    if (record.kind !== 'span' || record.traceId !== traceId) continue
    const time = BigInt(record.startTime ?? '0')
    if (time >= (finished.get(record.spanId) ?? 0n)) finished.set(record.spanId, time)
  }
  return records
    .filter(
      (r) =>
        r.kind === 'started' &&
        r.name === event &&
        r.traceId === traceId &&
        BigInt(r.time) > (finished.get(r.spanId) ?? -1n) &&
        accept(r)
    )
    .reduce<OtelRecord | undefined>(
      (latest, record) => (latest === undefined || BigInt(record.time) >= BigInt(latest.time) ? record : latest),
      undefined
    )
}

/** An OTLP decimal-nanosecond time as a time the tracer takes. */
export function timeInput(nanos: string): TimeInput {
  const value = BigInt(nanos)
  return [Number(value / 1_000_000_000n), Number(value % 1_000_000_000n)]
}

/** A record's attribute value as a writer takes it; anything else is dropped. */
export function attribute(value: unknown): Attrs[string] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
  if (Array.isArray(value) && value.every((item) => typeof item === 'boolean')) return value as boolean[]
  return undefined
}

/** The attributes a span's start carried, ready to write again on the whole span; the parent is split out. */
export function startAttributes(start: OtelRecord): { attrs: Attrs; parentId: string | undefined } {
  const attrs: Attrs = {}
  for (const key of Object.values(A)) attrs[key] = attribute(start.attributes[key])
  delete attrs[A.eventId]
  delete attrs[A.parentSpanId]
  const parentId = start.attributes[A.parentSpanId]
  return { attrs, parentId: typeof parentId === 'string' ? parentId : undefined }
}
