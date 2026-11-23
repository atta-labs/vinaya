import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A span as the local copy stores it: its name, trace and attributes by name. */
export type StoredSpan = { name: string; traceId: string; attributes: Record<string, string | number> }

/** An event as the local copy stores it: its name and attributes by name. */
export type StoredEvent = { name: string; attributes: Record<string, string | number> }

const attributesOf = (list: Array<{ key: string; value: { stringValue?: string; intValue?: string | number } }>) =>
  Object.fromEntries(list.map((a) => [a.key, a.value.stringValue ?? Number(a.value.intValue)]))

/** The documents of one signal in a repository's local copy folder, `<run>~<writer>~<n>.(traces|logs).jsonl`. */
function documents(folder: string, signal: 'traces' | 'logs'): any[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter((name) => name.endsWith(`.${signal}.jsonl`))
    .flatMap((name) => readFileSync(join(folder, name), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Every span a repository's local copy folder holds. */
export function storedSpans(folder: string): StoredSpan[] {
  return documents(folder, 'traces')
    .flatMap((doc) => doc.resourceSpans.flatMap((g: any) => g.scopeSpans.flatMap((s: any) => s.spans)))
    .map((span: any) => ({ name: span.name, traceId: span.traceId, attributes: attributesOf(span.attributes) }))
}

/** Every event a repository's local copy folder holds. */
export function storedEvents(folder: string): StoredEvent[] {
  return documents(folder, 'logs')
    .flatMap((doc) => doc.resourceLogs.flatMap((g: any) => g.scopeLogs.flatMap((s: any) => s.logRecords)))
    .map((record: any) => ({ name: String(record.eventName ?? ''), attributes: attributesOf(record.attributes) }))
}
