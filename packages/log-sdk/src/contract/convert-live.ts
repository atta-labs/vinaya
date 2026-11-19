import {
  ATTRIBUTE_NAMES as A,
  EARLIER_EVENT_PREFIX,
  EARLIER_WRITER_PREFIX,
  GENAI_CONVENTIONS_VERSION,
  SDK_VERSION
} from './catalogue.js'
import { type Fields, mapEarlierEvent } from './convert-map.js'
import { spanIdFor, traceIdFor } from './ids.js'
import { redact } from './redact.js'
import type { LogEvent } from './schema.js'
import { recordIdentity } from './store.js'

type Value =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: Value[] } }
  | { kvlistValue: { values: Attribute[] } }
  | Record<string, never>

type Attribute = { key: string; value: Value }
type Resource = { attributes: Attribute[] }
type LogRecord = {
  eventName: string
  traceId: string
  spanId: string
  flags: 1
  timeUnixNano: string
  attributes: Attribute[]
}
type Span = {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  kind: 1
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attribute[]
  status?: { code: 2 }
  events?: { name: string; timeUnixNano: string; attributes: Attribute[] }[]
}

export type ConvertedEarlierRecord = { resource: Resource } & (
  | { type: 'span'; record: Span }
  | { type: 'log'; record: LogRecord }
)
type StartedRecord = Extract<ConvertedEarlierRecord, { type: 'log' }>

/** A start recovered from an earlier process's started event. Times use OTLP decimal nanoseconds. */
export type EarlierOpenStart = { spanKey: string; startTimeUnixNano: string }
type OpenStart = EarlierOpenStart & { started?: StartedRecord }

function encodeAnyValue(value: unknown, home: string): Value {
  if (typeof value === 'string') return { stringValue: redact(value, home) }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => encodeAnyValue(item, home)) } }
  if (value !== null && typeof value === 'object') {
    return { kvlistValue: { values: attributesOf(value as Fields, home) } }
  }
  // An empty AnyValue preserves a present null, distinct from an absent attribute.
  return {}
}

function attributesOf(fields: Fields, home: string): Attribute[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: encodeAnyValue(value, home) }))
}

function earlierFields(event: LogEvent, keepUsage: boolean): Fields {
  const { meta, subject, kind, event: name, payload, ...fields } = event
  if (kind === 'custom') {
    return event.duration_ms === undefined ? {} : { [`${EARLIER_EVENT_PREFIX}duration_ms`]: event.duration_ms }
  }
  if (kind === 'dispatch' && event.event === 'outcome_received' && event.outcome.type === 'verdict') {
    const { outcome } = event
    Object.assign(fields, {
      outcome: { ...outcome, findings: outcome.findings.map(({ description, ...finding }) => finding) }
    })
  }
  if (kind === 'dev_review_loop' && event.event === 'verdicts_read' && event.findings !== undefined) {
    Object.assign(fields, { findings: event.findings.map(({ description, ...finding }) => finding) })
  }
  // Effect-bearing usage is encoded exactly once as GenAI attributes.
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => key !== 'prompt_hash' && (key !== 'usage' || keepUsage || event.event === 'dispatch_failed'))
      .map(([key, value]) => [`${EARLIER_EVENT_PREFIX}${key}`, value])
  )
}

function unixNano(timestamp: string): bigint {
  // Stored timestamps are UTC. The schema also accepts other strings, so
  // use OTLP's unset time for an unreadable or timezone-free timestamp.
  const millis = /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ? Date.parse(timestamp) : Number.NaN
  return Number.isFinite(millis) && millis >= 0 ? BigInt(millis) * 1_000_000n : 0n
}

function startOfDuration(end: bigint, durationMs = 0): bigint {
  if (!Number.isFinite(durationMs)) return end
  const millis = Math.trunc(durationMs)
  const nanos = BigInt(millis) * 1_000_000n + BigInt(Math.round((durationMs - millis) * 1_000_000))
  return nanos <= end ? end - nanos : 0n
}

export function createEarlierConversionState(runId: string, seeds: readonly EarlierOpenStart[], home: string) {
  const traceId = traceIdFor(runId)
  const open = new Map<string, OpenStart>(seeds.map((seed) => [seed.spanKey, { ...seed }]))
  const writtenEffects = new Set<string>()

  return {
    accept(event: LogEvent): { converted: ConvertedEarlierRecord; pairedStart?: StartedRecord } {
      const { meta, subject } = event
      if (meta.run_id !== runId) throw new Error('Earlier event belongs to a different run')
      const mapping = mapEarlierEvent(event)
      const identity = recordIdentity(event)
      if (identity === null) throw new Error('Earlier event has no record identity')
      const time = unixNano(meta.ts)
      const timeUnixNano = String(time)
      const started = mapping.mode === 'start'
      let key = mapping.key
      if (mapping.repeatable) {
        const prefix = `${mapping.key}#`
        key = prefix + spanIdFor(runId, identity)
        if (!started) {
          // The earlier format identifies the pause or question but carries
          // no instance id on its resolution. Use the oldest open instance.
          for (const candidate of open.keys()) {
            if (candidate.startsWith(prefix)) {
              key = candidate
              break
            }
          }
          // Accept a caller's unsuffixed key as well.
          if (open.has(mapping.key)) key = mapping.key
        }
      }
      const spanId = spanIdFor(runId, key)
      const agent = event.kind === 'dispatch' || event.kind === 'role_attempt'
      const openKey = agent ? `span:${spanId}` : key
      const laterAgentRecord = agent && writtenEffects.has(event.effect_id)
      if (agent && !started) writtenEffects.add(event.effect_id)
      // The parent is derived from the run id and the event's own round; it is never looked up.
      const parent = mapping.parent
      const resource = {
        attributes: attributesOf(
          {
            [A.serviceName]: meta.schema === 4 ? meta.process.id : 'vinaya',
            [A.serviceVersion]: meta.schema === 4 ? (meta.process.version ?? meta.vinaya) : meta.vinaya,
            [A.hostId]: meta.machine,
            [A.repository]: meta.repo ?? undefined,
            [A.sdkVersion]: SDK_VERSION,
            [A.semconvVersion]: GENAI_CONVENTIONS_VERSION
          },
          home
        )
      }
      const task =
        ('task' in event ? event.task : undefined) ??
        subject.issue ??
        (event.kind === 'forge_write' ? event.target.issue : undefined)
      const workRef = task == null ? ('work' in meta ? (meta.work.ref ?? undefined) : undefined) : String(task)
      const usage = mapping.usage
      const tokenAttributes: Fields = {}
      if (usage !== undefined && !laterAgentRecord) {
        tokenAttributes[A.usageInputTokens] = usage.input
        tokenAttributes[A.usageOutputTokens] = usage.output
      }
      const attributes = attributesOf(
        {
          ...earlierFields(event, laterAgentRecord),
          ...mapping.attributes,
          ...tokenAttributes,
          ...(event.kind === 'custom' ? {} : { [A.runId]: runId }),
          [A.seq]: meta.seq,
          [A.provenance]: event.kind === 'custom' ? 'reported' : 'governed',
          [A.trust]: 'provenance' in meta ? meta.provenance : 'unavailable',
          [A.workRef]: workRef,
          [A.workChange]: 'work' in meta ? (meta.work.change ?? undefined) : undefined,
          [A.workCommit]: 'work' in meta ? (meta.work.revision ?? undefined) : undefined,
          [A.round]: ('round' in event ? event.round : undefined) ?? subject.round,
          [A.seat]: agent ? mapping.attributes[A.agentName] : undefined,
          ...('input_versions' in meta
            ? {
                [A.inputBrief]: meta.input_versions.brief_hash ?? undefined,
                [A.inputObjectives]: meta.input_versions.objectives_version ?? undefined,
                [A.inputRuling]:
                  meta.input_versions.ruling_ordinal === null ? undefined : String(meta.input_versions.ruling_ordinal),
                [A.inputPolicy]: meta.input_versions.policy_digest ?? undefined
              }
            : {})
        },
        home
      )
      // Identity and correlation values must round trip exactly across writers.
      attributes.push(
        { key: A.eventId, value: { stringValue: identity } },
        {
          key: A.writerId,
          value: { stringValue: EARLIER_WRITER_PREFIX + ('process_id' in meta ? redact(meta.process_id, home) : runId) }
        }
      )
      if (mapping.repeatable) attributes.push({ key: A.questionKey, value: { stringValue: key } })
      if (started && !laterAgentRecord) attributes.push({ key: A.spanKey, value: { stringValue: openKey } })
      if (mapping.mode === 'event' || started || laterAgentRecord) {
        const eventName = laterAgentRecord ? `${EARLIER_EVENT_PREFIX}${event.kind}.${event.event}` : mapping.name
        const converted: StartedRecord = {
          type: 'log',
          resource,
          record: { eventName, traceId, spanId, timeUnixNano, attributes, flags: 1 }
        }
        if (started && !laterAgentRecord && !open.has(openKey)) {
          open.set(openKey, { spanKey: openKey, startTimeUnixNano: timeUnixNano, started: converted })
        }
        return { converted }
      }

      const start = mapping.mode === 'end' || agent ? open.get(openKey) : undefined
      if (start !== undefined) open.delete(openKey)
      const pairedStart = start?.started
      // A pause names why it began only on its start; the span that ends it carries the reason too.
      const carried = (pairedStart?.record.attributes ?? []).filter(
        ({ key }) => key === A.pauseWhy && !attributes.some((own) => own.key === key)
      )
      attributes.push(...carried)
      const converted: ConvertedEarlierRecord = {
        type: 'span',
        resource,
        record: {
          name: mapping.name,
          traceId,
          spanId,
          ...(parent === undefined ? {} : { parentSpanId: spanIdFor(runId, parent) }),
          kind: 1,
          startTimeUnixNano: start?.startTimeUnixNano ?? String(startOfDuration(time, mapping.durationMs)),
          endTimeUnixNano: timeUnixNano,
          attributes,
          ...(mapping.attributes[A.errorType] === undefined ? {} : { status: { code: 2 } }),
          ...(pairedStart === undefined
            ? {}
            : {
                events: [
                  {
                    name: pairedStart.record.eventName,
                    timeUnixNano: pairedStart.record.timeUnixNano,
                    attributes: pairedStart.record.attributes
                  }
                ]
              })
        }
      }
      return pairedStart === undefined ? { converted } : { converted, pairedStart }
    }
  }
}

/** Convert one event immediately in the sequence in which it is followed. */
export function createLiveEarlierConverter(runId: string, openStarts: readonly EarlierOpenStart[] = [], home = '') {
  const state = createEarlierConversionState(runId, openStarts, home)
  return {
    convert(event: LogEvent): ConvertedEarlierRecord {
      return state.accept(event).converted
    }
  }
}
