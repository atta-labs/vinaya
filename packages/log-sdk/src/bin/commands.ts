import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import { spanIdFor, type SpanParent } from '../contract/ids.js'
import { createFolderSource } from '../reader/folder-source.js'
import type { OtelRecord } from '../reader/records.js'
import { createReader } from '../reader/source.js'
import { attribute, latestOpenStart, startAttributes, timeInput } from '../reader/span-start.js'
import type { UsageRecorded } from '../writer/agent.js'
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
    incident: true,
    closed: true
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

async function findStart(
  event: string,
  handle: LogHandle,
  fields: Fields,
  folder: string
): Promise<{ start: OtelRecord; records: OtelRecord[] }> {
  const reader = createReader(createFolderSource({ folder, runId: handle.runId, canonicalFolder: true }))
  const { records } = await reader.readAll()
  const start = latestOpenStart(records, event, handle.traceId, (r) => matches(r, fields, handle))
  if (start === undefined) throw new MissingStart('missing start: ' + event)
  return { start, records }
}

const usageKeys = [
  A.usageInputTokens,
  A.usageOutputTokens,
  A.usageCacheReadInputTokens,
  A.usageCost,
  A.usageCostKind,
  A.usageUnknownReason,
  A.usageCostUnknownReason
]

function endTimeOf(value: unknown): TimeInput {
  if (value === undefined) return Date.now()
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value)
  throw new Error('endTime must be a non-negative number of milliseconds or a date string')
}

export async function invoke(command: string, handle: LogHandle, fields: Fields, folder: string): Promise<void> {
  if (command === 'usage recorded') {
    if (!handle.enabled) return
    const { start } = await findStart(E.agentStarted, handle, fields, folder)
    handle.usage.recorded({ ...(fields as UsageRecorded), agent: start, spanStart: start.time })
    return
  }
  if (Object.hasOwn(completions, command)) {
    const [event, base, suffix, endFields] = completions[command as keyof typeof completions]
    const { start, records } = await findStart(event, handle, fields, folder)

    const { attrs, parentId } = startAttributes(start)
    for (const [field, key] of Object.entries(endFields)) attrs[key] = attribute(fields[field])
    if (event === E.agentStarted) {
      const usage = [...records]
        .reverse()
        .find(
          (record) =>
            record.name === E.usageRecorded &&
            record.traceId === start.traceId &&
            record.spanId === start.spanId &&
            record.attributes[A.usageSpanStart] === start.time
        )
      if (usage !== undefined) for (const key of usageKeys) attrs[key] = attribute(usage.attributes[key])
    }

    const part = suffix === undefined ? undefined : attrs[suffix]
    const name = spanName(base, typeof part === 'string' || typeof part === 'number' ? part : undefined)
    const parent =
      parentId !== undefined
        ? { traceId: start.traceId, spanId: parentId }
        : event === E.runStarted
          ? undefined
          : { traceId: start.traceId, spanId: spanIdFor(handle.runId, 'run') }
    handle.writeSpan(name, start, parent, timeInput(start.time), endTimeOf(fields.endTime), attrs)
    return
  }

  const entry = commands.get(command)
  if (entry === undefined) throw new Error('unknown command')
  if (fields.endTime !== undefined) endTimeOf(fields.endTime)
  const group = handle[entry.group] as Record<string, (input: Fields) => unknown>
  group[entry.method]?.(fields)
}
