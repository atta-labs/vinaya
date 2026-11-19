import type { TimeInput } from '@opentelemetry/api'
import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import { spanIdFor, type SpanParent } from '../contract/ids.js'
import { createFolderSource } from '../reader/folder-source.js'
import type { OtelRecord } from '../reader/records.js'
import { createReader } from '../reader/source.js'
import { type UsageRecorded, usageAttributes } from '../writer/agent.js'
import { type Attrs, sanitize } from '../writer/attributes.js'
import type { LogHandle } from '../writer/connect.js'
import type { Fields } from './args.js'

type Subjects = Omit<
  LogHandle,
  'runId' | 'traceId' | 'writerId' | 'enabled' | 'settings' | 'writeSpan' | 'flush' | 'shutdown'
>
type Table = { [Group in keyof Subjects]: { [Method in keyof Subjects[Group]]: true } }

export const subjects = {
  run: {
    started: true,
    ended: true,
    alive: true,
    stageChanged: true,
    paused: true,
    resumed: true,
    cancelled: true,
    retried: true,
    stopRuleMet: true,
    exited: true
  },
  round: { started: true, ended: true },
  phase: { ended: true },
  agent: { sent: true, stepStarted: true, stepEnded: true, returned: true, failed: true, confidenceStated: true },
  usage: { recorded: true },
  review: { verdicts: true, findingsCompared: true },
  checks: { ran: true, notPassed: true, read: true, local: true, ci: true, rerun: true },
  change: {
    saved: true,
    pushed: true,
    opened: true,
    conflicted: true,
    recovered: true,
    merged: true,
    reverted: true,
    incident: true
  },
  person: { asked: true, answered: true },
  forge: { validated: true, refused: true, written: true },
  action: { verified: true },
  command: { completed: true },
  custom: { recorded: true }
} satisfies Table

export const commands = new Map(
  Object.entries(subjects).flatMap(([group, methods]) =>
    Object.keys(methods).map(
      (method) =>
        [
          group === 'custom' ? 'emit' : group + ' ' + method.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()),
          { group: group as keyof Subjects, method }
        ] as const
    )
  )
)

const completions = {
  'run ended': [
    E.runStarted,
    S.run,
    A.processName,
    {
      rounds: A.runRounds,
      totalMs: A.runTotalMs,
      timeToGreenMs: A.runTimeToGreenMs,
      filesChanged: A.runFilesChanged,
      outcome: A.runOutcome,
      errorType: A.errorType
    }
  ],
  'round ended': [
    E.roundStarted,
    S.round,
    A.roundNumber,
    {
      filesChanged: A.roundFilesChanged,
      linesAdded: A.roundLinesAdded,
      linesRemoved: A.roundLinesRemoved,
      outcome: A.roundOutcome,
      errorType: A.errorType
    }
  ],
  'agent returned': [
    E.agentStarted,
    S.agent,
    A.agentName,
    {
      outcome: A.agentOutcome,
      attempt: A.attempt,
      responseModel: A.responseModel
    }
  ],
  'agent failed': [
    E.agentStarted,
    S.agent,
    A.agentName,
    {
      resetAt: A.agentResetAt,
      attempt: A.attempt,
      errorType: A.errorType
    }
  ],
  'agent step-ended': [E.stepStarted, S.step, A.toolName, { errorType: A.errorType, errorLine: A.stepErrorLine }],
  'run resumed': [E.pauseStarted, S.pause, undefined, { by: A.pauseBy }],
  'person answered': [E.personAsked, S.person, A.questionKind, { by: A.answeredBy, answer: A.personAnswer }]
} as const

export class MissingStart extends Error {}

function asRef(value: unknown): SpanParent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const ref = value as Partial<SpanParent>
  return typeof ref.traceId === 'string' && typeof ref.spanId === 'string' ? (ref as SpanParent) : undefined
}

function matches(record: OtelRecord, fields: Fields, handle: LogHandle): boolean {
  const ref = asRef(fields.step ?? fields.agent ?? fields.pause)
  const id = typeof fields.key === 'string' ? spanIdFor(handle.runId, fields.key) : fields.spanId
  if (ref !== undefined) return ref.traceId === record.traceId && ref.spanId === record.spanId
  if (id !== undefined) return record.spanId === id
  return fields.round === undefined || (record.attributes[A.roundNumber] ?? record.attributes[A.round]) === fields.round
}

function timeInput(nanos: string): TimeInput {
  const value = BigInt(nanos)
  return [Number(value / 1_000_000_000n), Number(value % 1_000_000_000n)]
}

function attribute(value: unknown): Attrs[string] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
  if (Array.isArray(value) && value.every((item) => typeof item === 'boolean')) return value as boolean[]
  return undefined
}

async function findStart(event: string, handle: LogHandle, fields: Fields, folder: string): Promise<OtelRecord> {
  const reader = createReader(createFolderSource({ folder, runId: handle.runId }))
  const { records } = await reader.readAll()
  const finished = new Map<string, bigint>()
  for (const record of records) {
    if (record.kind !== 'span' || record.traceId !== handle.traceId) continue
    const time = BigInt(record.startTime ?? '0')
    if (time >= (finished.get(record.spanId) ?? 0n)) finished.set(record.spanId, time)
  }
  const start = records
    .filter(
      (r) =>
        r.kind === 'started' &&
        r.name === event &&
        r.traceId === handle.traceId &&
        BigInt(r.time) > (finished.get(r.spanId) ?? -1n) &&
        matches(r, fields, handle)
    )
    .reduce<OtelRecord | undefined>(
      (latest, record) => (latest === undefined || BigInt(record.time) >= BigInt(latest.time) ? record : latest),
      undefined
    )
  if (start === undefined) throw new MissingStart('missing start: ' + event)
  return start
}

// Usage is stored on the finished agent span. A separate invocation leaves
// its contribution beside the local records, keyed to this particular start.
function usagePrefix(start: OtelRecord): string {
  if (!/^[a-f0-9]{32}$/.test(start.traceId) || !/^[a-f0-9]{16}$/.test(start.spanId)) {
    throw new Error('invalid start identity')
  }
  return [start.traceId, start.spanId, start.time, 'usage'].join('~') + '~'
}

async function saveUsage(folder: string, handle: LogHandle, start: OtelRecord, fields: Fields): Promise<void> {
  const prefix = usagePrefix(start)
  const attrs = usageAttributes(fields as UsageRecorded)
  for (const key of Object.keys(attrs)) attrs[key] = attribute(attrs[key])
  const payload = JSON.stringify(sanitize({ home: homedir() }, attrs))
  const target = await realpath(folder)
  const name = prefix + Date.now() + '-' + handle.writerId
  const file = await open(
    join(target, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await file.writeFile(payload + '\n')
  } finally {
    await file.close()
  }
}

async function readUsage(folder: string, start: OtelRecord, attrs: Attrs): Promise<void> {
  const prefix = usagePrefix(start)
  const keys = Object.keys(usageAttributes({}))
  for (const name of (await readdir(folder)).filter((name) => name.startsWith(prefix)).sort()) {
    const file = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 64 * 1024) continue
      const raw = await file.readFile('utf8')
      if (!raw.endsWith('\n')) continue
      const entry: unknown = JSON.parse(raw)
      if (typeof entry === 'object' && entry !== null) {
        for (const key of keys) attrs[key] = attribute((entry as Fields)[key])
      }
    } finally {
      await file.close()
    }
  }
}

export async function invoke(command: string, handle: LogHandle, fields: Fields, folder: string): Promise<void> {
  if (command === 'usage recorded') {
    const start = await findStart(E.agentStarted, handle, fields, folder)
    await saveUsage(folder, handle, start, fields)
    return
  }
  if (Object.hasOwn(completions, command)) {
    const [event, base, suffix, endFields] = completions[command as keyof typeof completions]
    const start = await findStart(event, handle, fields, folder)

    const attrs: Attrs = {}
    for (const key of Object.values(A)) attrs[key] = attribute(start.attributes[key])
    delete attrs[A.eventId]
    for (const [field, key] of Object.entries(endFields)) attrs[key] = attribute(fields[field])
    if (event === E.agentStarted) await readUsage(folder, start, attrs)

    const part = suffix === undefined ? undefined : attrs[suffix]
    const name = spanName(base, typeof part === 'string' || typeof part === 'number' ? part : undefined)
    const parentId = start.attributes[A.parentSpanId]
    delete attrs[A.parentSpanId]
    const parent =
      typeof parentId === 'string'
        ? { traceId: start.traceId, spanId: parentId }
        : event === E.runStarted
          ? undefined
          : { traceId: start.traceId, spanId: spanIdFor(handle.runId, 'run') }
    handle.writeSpan(
      name,
      start,
      parent,
      timeInput(start.time),
      (fields.endTime as TimeInput | undefined) ?? Date.now(),
      attrs
    )
    return
  }

  const entry = commands.get(command)
  if (entry === undefined) throw new Error('unknown command')
  const group = handle[entry.group] as Record<string, (input: Fields) => unknown>
  group[entry.method]?.(fields)
}
