import type { Attributes, OtelRecord } from '../reader/records.js'
import { ALL_ATTRIBUTE_NAMES, ALL_EVENT_NAMES, EARLIER_EVENT_PREFIX, isSpanName } from './catalogue.js'

const RESERVED = 'vinaya.'
const attributeNames: ReadonlySet<string> = new Set(ALL_ATTRIBUTE_NAMES)
const eventNames: ReadonlySet<string> = new Set(ALL_EVENT_NAMES)

/** The first name of a record that does not fit the Log's contract, and where it was found. */
export type ContractFailure = {
  name: string
  field: 'span name' | 'event name' | 'span attribute' | 'event attribute' | 'resource attribute'
}

/** The record parts the check reads. */
export type CheckableRecord = Pick<OtelRecord, 'kind' | 'name' | 'attributes' | 'resource'>

function reserved(name: string): boolean {
  return name.startsWith(RESERVED)
}

function earlier(name: string): boolean {
  return name.startsWith(EARLIER_EVENT_PREFIX)
}

function firstUnknown(attributes: Attributes): string | undefined {
  return Object.keys(attributes).find((name) => reserved(name) && !attributeNames.has(name) && !earlier(name))
}

/**
 * Whether a record fits the Log's contract: no `vinaya.*` span name, event
 * name or attribute name outside the catalogue (or the earlier-event
 * namespace). Every other name is kept as it comes. Returns the first failing
 * name, or `null` when the record fits.
 */
export function checkRecordContract(record: CheckableRecord): ContractFailure | null {
  const isSpan = record.kind === 'span'
  if (reserved(record.name) && !earlier(record.name)) {
    const known = isSpan ? isSpanName(record.name) : eventNames.has(record.name)
    if (!known) return { name: record.name, field: isSpan ? 'span name' : 'event name' }
  }
  const attribute = firstUnknown(record.attributes)
  if (attribute !== undefined) return { name: attribute, field: isSpan ? 'span attribute' : 'event attribute' }
  const resource = firstUnknown(record.resource)
  if (resource !== undefined) return { name: resource, field: 'resource attribute' }
  return null
}

/** The sentence a rejection or gap carries for a failing name. */
export function describeContractFailure(failure: ContractFailure): string {
  return `${failure.field} "${failure.name}" is not in the Log's contract`
}
