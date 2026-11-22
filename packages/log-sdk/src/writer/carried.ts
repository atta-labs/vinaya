import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, type SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import { type SpanParent, spanIdFor } from '../contract/ids.js'
import { createLineReader } from '../reader/lines.js'
import type { OtelRecord } from '../reader/records.js'
import { latestOpenStart, startAttributes, timeInput } from '../reader/span-start.js'
import type { Attrs, WriterCore } from './attributes.js'
import type { StartRun } from './run.js'
import { writeWholeSpan } from './whole-span.js'

/**
 * Every record of this run's local copy, read synchronously. A missing folder
 * is an empty copy; any other failure is reported and the records read so far
 * are kept. `others` leaves out the files this handle wrote itself.
 */
export function copyRecords(core: WriterCore, which: 'all' | 'others' = 'all'): OtelRecord[] {
  const copy = core.copy
  if (!core.enabled || copy === undefined) return []
  let folder: string
  let names: string[]
  try {
    folder = copy.folder()
    names = readdirSync(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') core.report(error)
    return []
  }
  const lines = createLineReader('local copy of ' + core.runId)
  const records: OtelRecord[] = []
  for (const file of names.sort()) {
    if (!file.startsWith(copy.prefix) || !/\.(?:traces|logs)\.jsonl$/.test(file)) continue
    if (which === 'others' && file.startsWith(`${copy.prefix}${core.writerId}~`)) continue
    try {
      const path = join(folder, file)
      if (!lstatSync(path).isFile()) continue
      const text = readFileSync(path, 'utf8')
      // A last line without its newline is still being written.
      const whole = text.slice(0, text.lastIndexOf('\n') + 1)
      for (const line of whole.split('\n')) {
        if (line.trim() === '') continue
        records.push(...lines.readLine(line).records)
      }
    } catch (error) {
      core.report(error)
    }
  }
  return records
}

/** The latest open start of `event` in the copy, by the rule the `vinaya-log` command follows. */
export function findOpenStart(
  core: WriterCore,
  event: string,
  accept?: (record: OtelRecord) => boolean,
  which: 'all' | 'others' = 'all'
): OtelRecord | undefined {
  return latestOpenStart(copyRecords(core, which), event, core.traceId, accept)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function defined(attrs: Attrs): Attrs {
  return Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined))
}

/**
 * A process that did not start a span writes it whole: its start time and
 * start attributes come from the span's started event in the local copy.
 */
export function endFromCopy(
  core: WriterCore,
  spec: {
    event: string
    base: (typeof S)[keyof typeof S]
    /** The start attribute the span name's last part is filled from. */
    suffix?: string
    start?: OtelRecord
    accept?: (record: OtelRecord) => boolean
    /** The parent when the start names none. */
    parent: SpanParent | undefined
    attrs: Attrs
    endTime?: TimeInput | undefined
    errorType?: string | undefined
  }
): void {
  const start = spec.start ?? findOpenStart(core, spec.event, spec.accept)
  if (start === undefined) throw new Error(`missing start: ${spec.event}`)
  const { attrs, parentId } = startAttributes(start)
  const part = spec.suffix === undefined ? undefined : attrs[spec.suffix]
  const name = spanName(spec.base, typeof part === 'string' || typeof part === 'number' ? part : undefined)
  const parent = parentId === undefined ? spec.parent : { traceId: start.traceId, spanId: parentId }
  writeWholeSpan(
    core,
    name,
    { traceId: start.traceId, spanId: start.spanId },
    parent,
    timeInput(start.time),
    spec.endTime ?? core.now(),
    { ...attrs, ...defined(spec.attrs), [A.errorType]: spec.errorType }
  )
}

/**
 * Carries on a run another process started: no second start is written, and
 * the open round and the last stage are taken up from the copy. `undefined`
 * when no other process left an open run start there.
 */
export function carryOn(core: WriterCore, options: StartRun): SpanParent | undefined {
  if (!core.enabled) return undefined
  const spanId = options.spanId ?? spanIdFor(core.runId, options.key ?? 'run')
  const records = copyRecords(core, 'others')
  const start = latestOpenStart(records, E.runStarted, core.traceId, (r) => r.spanId === spanId)
  if (start === undefined) return undefined
  const ref = { traceId: start.traceId, spanId: start.spanId }
  for (const key of ['ref', 'title', 'change', 'commit'] as const) {
    const value = options.work?.[key]
    if (value !== undefined) core.work[key] = value
  }
  for (const key of ['brief', 'objectives', 'ruling', 'policy'] as const) {
    const value = options.inputs?.[key]
    if (value !== undefined) core.inputs[key] = value
  }
  core.current.run = ref
  const round = latestOpenStart(records, E.roundStarted, core.traceId)
  if (round !== undefined) {
    core.current.round = { traceId: round.traceId, spanId: round.spanId }
    const number = round.attributes[A.roundNumber]
    if (typeof number === 'number') core.moment.round = number
  }
  const stage = records
    .filter((r) => r.kind === 'event' && r.name === E.stageChanged && r.traceId === core.traceId)
    .reduce<OtelRecord | undefined>(
      (latest, r) => (latest === undefined || BigInt(r.time) >= BigInt(latest.time) ? r : latest),
      undefined
    )
  const to = text(stage?.attributes[A.stageTo])
  if (to !== undefined) core.moment.stage = to
  return ref
}
