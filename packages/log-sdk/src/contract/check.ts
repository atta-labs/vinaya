import type { OtelRecord } from '../reader/records.js'
import { ALL_ATTRIBUTE_NAMES, ALL_EVENT_NAMES, EARLIER_EVENT_PREFIX, isSpanName } from './catalogue.js'

const attributeNames: ReadonlySet<string> = new Set(ALL_ATTRIBUTE_NAMES)
const eventNames: ReadonlySet<string> = new Set(ALL_EVENT_NAMES)

type Field = 'span name' | 'event name' | 'span attribute' | 'event attribute' | 'resource attribute'

/** A name a record carries in the reserved `vinaya.` namespace, and where it was found. */
export type ReservedName = { name: string; field: Field }

/** The first name of a record that does not fit the Log's contract, and where it was found. */
export type ContractFailure = ReservedName

/** The record parts the check reads. */
export type CheckableRecord = Pick<OtelRecord, 'kind' | 'name' | 'attributes' | 'resource'>

/**
 * Every `vinaya.*` name an OTLP JSON document's records carry, in record
 * order (a record's name, then its attributes, then its resource's).
 * Self-contained, so the sender can run it in a worker beside the JSON check.
 */
export function reservedNamesOf(document: unknown): ReservedName[] {
  const out: ReservedName[] = []
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const keys = (attributes: unknown): string[] => {
    const found: string[] = []
    for (const entry of list(attributes)) {
      if (isObject(entry) && typeof entry.key === 'string') found.push(entry.key)
    }
    return found
  }
  const seen = new Set<string>()
  const add = (name: string, field: Field) => {
    if (!name.startsWith('vinaya.') || seen.has(`${field}\u0000${name}`)) return
    seen.add(`${field}\u0000${name}`)
    out.push({ name, field })
  }
  const eventName = (log: Record<string, unknown>): string => {
    if (typeof log.eventName === 'string' && log.eventName !== '') return log.eventName
    let named = ''
    for (const entry of list(log.attributes)) {
      if (isObject(entry) && entry.key === 'event.name') {
        const value = isObject(entry.value) ? entry.value.stringValue : undefined
        named = typeof value === 'string' ? value : ''
      }
    }
    if (named !== '') return named
    return isObject(log.body) && typeof log.body.stringValue === 'string' ? log.body.stringValue : ''
  }
  if (!isObject(document)) return out
  for (const group of list(document.resourceSpans)) {
    if (!isObject(group)) continue
    const resource = keys(isObject(group.resource) ? group.resource.attributes : undefined)
    for (const scope of list(group.scopeSpans)) {
      if (!isObject(scope)) continue
      for (const span of list(scope.spans)) {
        if (!isObject(span)) continue
        if (typeof span.name === 'string') add(span.name, 'span name')
        for (const key of keys(span.attributes)) add(key, 'span attribute')
        for (const key of resource) add(key, 'resource attribute')
      }
    }
  }
  for (const group of list(document.resourceLogs)) {
    if (!isObject(group)) continue
    const resource = keys(isObject(group.resource) ? group.resource.attributes : undefined)
    for (const scope of list(group.scopeLogs)) {
      if (!isObject(scope)) continue
      for (const log of list(scope.logRecords)) {
        if (!isObject(log)) continue
        add(eventName(log), 'event name')
        for (const key of keys(log.attributes)) add(key, 'event attribute')
        for (const key of resource) add(key, 'resource attribute')
      }
    }
  }
  return out
}

/** The first reserved name outside the catalogue and the earlier-event namespace, or `null`. */
export function checkReservedNames(names: readonly ReservedName[]): ContractFailure | null {
  for (const use of names) {
    if (use.name.startsWith(EARLIER_EVENT_PREFIX)) continue
    const known =
      use.field === 'span name'
        ? isSpanName(use.name)
        : use.field === 'event name'
          ? eventNames.has(use.name)
          : attributeNames.has(use.name)
    if (!known) return use
  }
  return null
}

/**
 * Whether a record fits the Log's contract: no `vinaya.*` span name, event
 * name or attribute name outside the catalogue (or the earlier-event
 * namespace). Every other name is kept as it comes. Returns the first failing
 * name, or `null` when the record fits.
 */
export function checkRecordContract(record: CheckableRecord): ContractFailure | null {
  const isSpan = record.kind === 'span'
  const names: ReservedName[] = []
  const add = (name: string, field: Field) => {
    if (name.startsWith('vinaya.')) names.push({ name, field })
  }
  add(record.name, isSpan ? 'span name' : 'event name')
  for (const key of Object.keys(record.attributes)) add(key, isSpan ? 'span attribute' : 'event attribute')
  for (const key of Object.keys(record.resource)) add(key, 'resource attribute')
  return checkReservedNames(names)
}

/** The sentence a rejection or gap carries for a failing name. */
export function describeContractFailure(failure: ContractFailure): string {
  return `${failure.field} "${failure.name}" is not in the Log's contract`
}
