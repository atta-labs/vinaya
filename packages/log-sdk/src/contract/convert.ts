import { SDK_VERSION } from './catalogue.js'
import { type ConvertedEarlierRecord, createEarlierConversionState } from './convert-live.js'
import type { LogEvent } from './schema.js'

const scope = { name: '@attalabs/vinaya-log-sdk', version: SDK_VERSION }
type Resource = ConvertedEarlierRecord['resource']
type Span = Extract<ConvertedEarlierRecord, { type: 'span' }>['record']
type LogRecord = Extract<ConvertedEarlierRecord, { type: 'log' }>['record']

export type EarlierOtlpDocuments = {
  traces: { resourceSpans: { resource: Resource; scopeSpans: { scope: typeof scope; spans: Span[] }[] }[] }
  logs: { resourceLogs: { resource: Resource; scopeLogs: { scope: typeof scope; logRecords: LogRecord[] }[] }[] }
}

/** Convert validated events from one run, in sequence order, to two OTLP JSON documents. */
export function convertEarlierEvents(events: readonly LogEvent[], home = ''): EarlierOtlpDocuments {
  const output: EarlierOtlpDocuments = { traces: { resourceSpans: [] }, logs: { resourceLogs: [] } }
  const first = events[0]
  if (first === undefined) return output

  const state = createEarlierConversionState(first.meta.run_id, [], home)
  const records = new Set<ConvertedEarlierRecord>()
  for (const event of events) {
    const { converted, pairedStart } = state.accept(event)
    if (pairedStart !== undefined) records.delete(pairedStart)
    records.add(converted)
  }
  // Keep consecutive records with the same resource together without reordering
  // records when several historical producers share the run.
  let lastSpanResource: string | undefined
  let lastLogResource: string | undefined
  for (const { resource, record, type } of records) {
    const key = JSON.stringify(resource)
    if (type === 'span') {
      const group = output.traces.resourceSpans.at(-1)?.scopeSpans[0]
      if (group !== undefined && key === lastSpanResource) group.spans.push(record)
      else output.traces.resourceSpans.push({ resource, scopeSpans: [{ scope: { ...scope }, spans: [record] }] })
      lastSpanResource = key
    } else {
      const group = output.logs.resourceLogs.at(-1)?.scopeLogs[0]
      if (group !== undefined && key === lastLogResource) group.logRecords.push(record)
      else output.logs.resourceLogs.push({ resource, scopeLogs: [{ scope: { ...scope }, logRecords: [record] }] })
      lastLogResource = key
    }
  }
  return output
}
