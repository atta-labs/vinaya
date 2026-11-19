import { FORBIDDEN_CONTENT_ATTRIBUTES } from '../contract/catalogue.js'
import { redact } from '../contract/redact.js'
import type { AttributeValue, Attributes, OtelRecord } from './records.js'

const FORBIDDEN: ReadonlySet<string> = new Set(FORBIDDEN_CONTENT_ATTRIBUTES)

function isPlainObject(value: AttributeValue): value is { [key: string]: AttributeValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clean(value: AttributeValue, home: string): AttributeValue {
  if (typeof value === 'string') return redact(value, home)
  if (Array.isArray(value)) return value.map((item) => clean(item, home))
  if (isPlainObject(value)) return cleanAttributes(value, home)
  return value
}

/** Attributes with the GenAI content attributes dropped and every string value redacted. */
function cleanAttributes(attributes: Attributes, home: string): Attributes {
  const out = Object.create(null) as Record<string, AttributeValue>
  for (const [key, value] of Object.entries(attributes)) {
    if (FORBIDDEN.has(key)) continue
    out[key] = clean(value, home)
  }
  return out
}

/**
 * Applies the reader's trust and redaction to one record.
 *
 * A record states its provenance, `governed` or `reported`, or states none;
 * one that states none is `reported`, and so is every record of a foreign
 * source, whatever it claims. The GenAI content attributes (messages, tool
 * call arguments and results) are dropped and every string value passes the
 * Log's redaction. Nothing dropped is kept anywhere.
 */
export function applyTrust(record: OtelRecord, options: { foreign: boolean; home?: string }): OtelRecord {
  const home = options.home ?? ''
  return {
    ...record,
    name: redact(record.name, home),
    attributes: cleanAttributes(record.attributes, home),
    resource: cleanAttributes(record.resource, home),
    provenance: options.foreign ? 'reported' : record.provenance
  }
}
