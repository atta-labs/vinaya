import { createLiveEarlierConverter } from '../contract/convert-live.js'
import { classifyStoredLine } from '../contract/store.js'
import { decodeAttributes, decodeLog, decodeSpan, type OtelRecord } from './records.js'

/** Why a line gave no record. A problem never carries the line's own text. */
export type LineProblem = {
  reason: 'not_json' | 'not_a_log_line' | 'unknown_version' | 'invalid_earlier_line' | 'conversion_failed'
  detail: string
}

export type LineResult = { records: OtelRecord[]; problem: LineProblem | null }

export type LineReader = {
  /** One stored line: an OTLP traces or logs document, or an earlier-format line. Never throws. */
  readLine(line: string): LineResult
  /** One OTLP traces or logs document already parsed. `null` when the value is neither. */
  readDocument(document: unknown): OtelRecord[] | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Reads an OTLP traces or logs document; `null` when the value is neither. */
export function readOtlpDocument(document: unknown, source: string): OtelRecord[] | null {
  if (!isObject(document)) return null
  const hasSpans = Array.isArray(document.resourceSpans)
  const hasLogs = Array.isArray(document.resourceLogs)
  if (!hasSpans && !hasLogs) return null
  const records: OtelRecord[] = []
  for (const group of list(document.resourceSpans)) {
    if (!isObject(group)) continue
    const resource = decodeAttributes(isObject(group.resource) ? group.resource.attributes : undefined)
    for (const scope of list(group.scopeSpans)) {
      if (!isObject(scope)) continue
      for (const span of list(scope.spans)) {
        const record = decodeSpan(resource, span, source)
        if (record) records.push(record)
      }
    }
  }
  for (const group of list(document.resourceLogs)) {
    if (!isObject(group)) continue
    const resource = decodeAttributes(isObject(group.resource) ? group.resource.attributes : undefined)
    for (const scope of list(group.scopeLogs)) {
      if (!isObject(scope)) continue
      for (const log of list(scope.logRecords)) {
        const record = decodeLog(resource, log, source)
        if (record) records.push(record)
      }
    }
  }
  return records
}

/**
 * A reader of lines for one source. Earlier-format lines are converted one at
 * a time by the live converter of their run, which the reader keeps for the
 * life of the source.
 */
export function createLineReader(source: string, options: { home?: string } = {}): LineReader {
  const home = options.home ?? ''
  const converters = new Map<string, ReturnType<typeof createLiveEarlierConverter>>()

  function earlier(line: string): LineResult {
    const stored = classifyStoredLine(line, home)
    if (stored.status === 'unknown_version') {
      return {
        records: [],
        problem: { reason: 'unknown_version', detail: `a line with schema version ${stored.schema ?? 'unknown'}` }
      }
    }
    if (stored.status === 'invalid') {
      return { records: [], problem: { reason: 'invalid_earlier_line', detail: stored.reason } }
    }
    try {
      let converter = converters.get(stored.runId)
      if (converter === undefined) {
        converter = createLiveEarlierConverter(stored.runId, [], home)
        converters.set(stored.runId, converter)
      }
      const converted = converter.convert(stored.event)
      const resource = decodeAttributes(converted.resource.attributes)
      const record =
        converted.type === 'span'
          ? decodeSpan(resource, converted.record, source)
          : decodeLog(resource, converted.record, source)
      return { records: record ? [record] : [], problem: null }
    } catch {
      return {
        records: [],
        problem: { reason: 'conversion_failed', detail: 'the earlier line could not be converted' }
      }
    }
  }

  return {
    readDocument: (document) => readOtlpDocument(document, source),
    readLine(line) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return { records: [], problem: { reason: 'not_json', detail: 'the line is not valid JSON' } }
      }
      if (!isObject(parsed)) {
        return { records: [], problem: { reason: 'not_a_log_line', detail: 'the line is not a JSON object' } }
      }
      const records = readOtlpDocument(parsed, source)
      if (records !== null) return { records, problem: null }
      if (isObject(parsed.meta)) return earlier(line)
      return {
        records: [],
        problem: { reason: 'not_a_log_line', detail: 'the line is neither an OTLP document nor an earlier Log line' }
      }
    }
  }
}
