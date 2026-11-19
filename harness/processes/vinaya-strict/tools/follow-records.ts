import { readdir } from 'node:fs/promises'
import {
  ATTRIBUTE_NAMES as A,
  EVENT_NAMES as E,
  SPAN_NAMES as S
} from '../../../../packages/log-sdk/src/contract/catalogue.js'
import { spanIdFor } from '../../../../packages/log-sdk/src/contract/ids.js'
import { agentSpanIdFor } from '../../../../packages/log-sdk/src/contract/convert-map.js'
import { narrate } from '../../../../packages/log-sdk/src/narration/narrate.js'
import { createFolderSource } from '../../../../packages/log-sdk/src/reader/folder-source.js'
import type { OtelRecord } from '../../../../packages/log-sdk/src/reader/records.js'
import { createReader, type ReaderUpdate } from '../../../../packages/log-sdk/src/reader/source.js'
import { type AgentLineMark, renderNarratedUpdate } from '../../../kernel/adapters/agents/agent-line.js'
import type { ActionKind } from '../../../kernel/adapters/agents/claude-code/loop-narration-claude.js'
import { lookupRole, registeredRoles } from '../../../kernel/log/roles.js'
import type { Role } from '../../../kernel/log/schema.js'
import {
  createFollowRenderer,
  type DriverLogLine,
  type FollowViewOptions,
  isStage,
  parseDriverLogLine
} from './follow-view.js'

/** Follow each matching run from the beginning, keeping its reader across polls. */
export function readTaskRuns(folder: string, issue: number, home: string) {
  const runs = new Map<string, { pull: () => Promise<ReaderUpdate>; matches?: boolean; gaps: ReaderUpdate['gaps'] }>()
  return {
    async pull(): Promise<Pick<ReaderUpdate, 'records' | 'gaps'> | null> {
      const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const name of names) {
        const runId = /^([A-Za-z0-9][A-Za-z0-9._-]*)~[A-Za-z0-9._-]+~\d{12}\.(?:logs|traces)\.jsonl$/.exec(name)?.[1]
        if (!runId || runId.includes('..') || runs.has(runId)) continue
        const reader = createReader(createFolderSource({ folder, runId, home }), { home, patience: 1 })
        runs.set(runId, { pull: reader.pull, gaps: [] })
      }
      const batches: OtelRecord[][] = []
      const gaps: ReaderUpdate['gaps'] = []
      for (const run of runs.values()) {
        if (run.matches === false) continue
        const update = await run.pull()
        if (run.matches === undefined) {
          // A run's work reference is fixed. An empty or torn first write can be retried.
          const refs = update.records.map((record) => record.attributes[A.workRef]).filter((ref) => ref != null)
          if (refs.length > 0) run.matches = refs.includes(String(issue))
          if (run.matches === undefined) run.gaps.push(...update.gaps)
          if (!run.matches) continue
          gaps.push(...run.gaps)
          run.gaps = []
        }
        if (update.records.length > 0) batches.push(update.records)
        gaps.push(...update.gaps)
      }
      return [...runs.values()].some((run) => run.matches) ? { records: mergeRuns(batches), gaps } : null
    }
  }
}

/** Interleave runs without undoing the SDK's per-run ordering. */
function mergeRuns(batches: OtelRecord[][]): OtelRecord[] {
  const positions = batches.map(() => 0)
  const output: OtelRecord[] = []
  for (;;) {
    let next: OtelRecord | undefined
    let from = 0
    for (const [i, batch] of batches.entries()) {
      const candidate = batch[positions[i] ?? 0]
      if (candidate && (!next || BigInt(candidate.time) < BigInt(next.time))) {
        next = candidate
        from = i
      }
    }
    if (!next) return output
    output.push(next)
    positions[from] = (positions[from] ?? 0) + 1
  }
}

const marks: Record<NonNullable<ReturnType<typeof narrate>>['kind'], AgentLineMark> = {
  starting: 'round',
  working: 'working',
  done: 'done',
  failed: 'failed',
  waiting: 'waiting',
  paused: 'waiting',
  blocked: 'waiting',
  information: 'working'
}
const actionKinds: ReadonlySet<string> = new Set([
  'reading',
  'searching',
  'editing',
  'creating',
  'removing',
  'running_tests',
  'type_checking',
  'git',
  'github',
  'tool_request',
  'skill',
  'fetching',
  'delegating',
  'reporting',
  'running',
  'checking',
  'publishing',
  'working'
])

const word = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const timeOf = (record: OtelRecord): number => Number(BigInt(record.time) / 1_000_000n)
const spanNamed = (record: OtelRecord, name: string): boolean =>
  record.kind === 'span' && (record.name === name || record.name.startsWith(`${name} `))

type Primary = Extract<DriverLogLine, { kind: 'primary' }>
type Step = { call: string; line: Primary }
type Detail = { at: number; call?: string; label: string; text: string; poll: number }

function terminalText(text: string): string {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : character
  }).join('')
}

function escapeRecordLine(line: DriverLogLine): DriverLogLine {
  if (line.kind === 'primary') {
    return {
      ...line,
      words: terminalText(line.words),
      label: terminalText(line.label),
      ...(line.details ? { details: line.details.map(terminalText) } : {}),
      ...(typeof line.meta.reason === 'string'
        ? { meta: { ...line.meta, reason: terminalText(line.meta.reason) } }
        : {})
    }
  }
  if (line.kind === 'runner' || line.kind === 'step-detail') return { ...line, text: terminalText(line.text) }
  return line
}

export function createRecordFollow(options: FollowViewOptions) {
  const renderer = createFollowRenderer(options)
  const seatNames = Object.fromEntries(
    registeredRoles().flatMap((name) => {
      const role = lookupRole(name)
      return role === undefined ? [] : [[name, role] as const]
    })
  )
  const agents = new Map<string, Map<string, string>>()
  const agentsRunIds = new Map<string, string>()
  const stepSeats = new Map<string, Role>()
  const earlier = new Map<string, OtelRecord[]>()
  const pauseReasons = new Map<string, string>()
  const previousSteps: Step[] = []
  let pending: Detail[] = []
  let owner: Primary | undefined
  let poll = 0

  function seat(record: OtelRecord, call: string | undefined): Role | undefined {
    const a = record.attributes
    const direct = word(a[A.agentName]) ?? word(a[A.seat])
    if (direct !== undefined && lookupRole(direct)) return direct as Role
    if (record.parentSpanId !== null) {
      for (const [effect, role] of agents.get(record.traceId) ?? []) {
        const runId = agentsRunIds.get(record.traceId)
        if (runId && agentSpanIdFor(runId, effect) === record.parentSpanId) return role as Role
      }
    }
    const runAgents = agents.get(record.traceId)
    const runId = word(a[A.runId])
    if (runAgents && call && runId) {
      for (const [effect, role] of runAgents) {
        if (spanIdFor(runId, `step:${effect}:${call}`) === record.spanId) return role as Role
      }
    }
    return undefined
  }

  function translate(record: OtelRecord): { line: DriverLogLine; step?: Step } | undefined {
    const a = record.attributes
    const at = timeOf(record)
    const round = a[A.roundNumber] ?? a[A.round]
    // A reported record is never governed loop activity: no banner, no loop narration, no run reset, only a marked line.
    if (a[A.provenance] === 'reported') {
      return {
        line: {
          kind: 'primary',
          at,
          mark: 'working',
          label: 'Reported',
          words: `${record.name} (reported, not governed)`,
          meta: {}
        }
      }
    }
    if (record.name === E.runStarted || record.name === E.cancelled) {
      return { line: { kind: 'reset', run: record.traceId } }
    }
    if (record.name === E.pauseStarted) {
      const reason = word(a[A.pauseWhy])
      if (reason) pauseReasons.set(record.traceId, reason)
    }
    const stage = a[A.stageTo]
    if (record.name === E.stageChanged && isStage(stage) && typeof round === 'number') {
      const reason = word(a[A.pauseWhy]) ?? pauseReasons.get(record.traceId)
      return {
        line: {
          kind: 'primary',
          at,
          mark: 'round',
          label: 'Loop',
          words: '',
          run: record.traceId,
          meta: {
            stage,
            round: String(round),
            ...(stage.startsWith('paused_') && reason ? { reason } : {})
          }
        }
      }
    }
    if (record.name === E.stepStarted || spanNamed(record, S.step)) {
      const call = word(a[A.toolCallId])
      const recordedKind = word(a[A.stepKind])
      const subject = word(a[A.stepTarget]) ?? word(a[A.toolName])
      if (!call || !recordedKind || !subject) return undefined
      const kind = actionKinds.has(recordedKind) ? (recordedKind as ActionKind) : 'working'
      const key = `${record.traceId}/${record.spanId}`
      const role = seat(record, call) ?? stepSeats.get(key)
      if (record.kind === 'span') stepSeats.delete(key)
      else if (role) stepSeats.set(key, role)
      const errorType = word(a[A.errorType])
      const confidence = a[A.confidence]
      const failedCount = /^(\d+) failed$/.exec(word(a[A.stepErrorLine]) ?? '')?.[1]
      const parts =
        record.kind === 'span'
          ? renderNarratedUpdate({
              type: 'result',
              id: call,
              kind,
              subject,
              ok: errorType === undefined,
              durationMs: Number(BigInt(record.time) - BigInt(record.startTime ?? record.time)) / 1_000_000,
              ...(failedCount !== undefined ? { failedTests: Number(failedCount) } : {})
            })
          : renderNarratedUpdate({
              type: 'action',
              id: call,
              kind,
              subject,
              at,
              ...(kind === 'reporting' && typeof confidence === 'number' ? { confidence } : {})
            })
      const line: Primary = {
        kind: 'primary',
        at,
        label: (role && lookupRole(role)?.title) || 'Agent',
        mark: parts.mark,
        words: parts.words,
        meta: { call: `${record.traceId}/${call}` },
        details: [],
        ...(role ? { role } : {})
      }
      return { line, step: { call, line } }
    }
    const history = earlier.get(record.traceId) ?? []
    const narration = narrate(record, seatNames, history)
    if (record.name === E.confidenceStated || record.name === E.checkRead) {
      history.push(record)
      earlier.set(record.traceId, history)
    }
    if (!narration) return undefined
    return {
      line: {
        kind: 'primary',
        at,
        label: 'Loop',
        mark: marks[narration.kind],
        words: narration.text,
        meta: {},
        run: record.traceId,
        endsStage: record.name === E.exited
      }
    }
  }

  function attachDetails(raw: readonly string[], steps: Step[], through: number): DriverLogLine[] {
    if (!options.details) return []
    poll += 1
    for (const text of raw) {
      const line = parseDriverLogLine(text)
      if (line.kind === 'primary') owner = line
      else if (line.kind === 'runner' || line.kind === 'untimed') owner = undefined
      else if (line.kind === 'detail' && owner) {
        // A detail the driver-log view already printed is not shown again; its full command never was.
        if (owner.at <= through && line.meta.command !== true) continue
        const call = word(line.meta.call) ?? word(owner.meta.call)
        pending.push({ at: owner.at, label: owner.label, text: line.text, poll, ...(call ? { call } : {}) })
      }
    }
    const trailing: DriverLogLine[] = []
    const candidates = [...previousSteps, ...steps]
    const fresh = new Set(steps)
    pending = pending.filter((detail) => {
      let match: Step | undefined
      let distance = Number.POSITIVE_INFINITY
      let latest: Step | undefined
      for (const candidate of candidates) {
        const { line } = candidate
        if (line.role !== undefined && line.label !== detail.label) continue
        const delta = Math.abs(line.at - detail.at)
        if (detail.call === candidate.call && delta <= distance) {
          distance = delta
          match = candidate
        }
        if (line.label === detail.label && line.at <= detail.at && (!latest || line.at >= latest.line.at))
          latest = candidate
      }
      // Let the SDK catch up across one poll before using the seat fallback.
      const canFallback = detail.call === undefined || poll > detail.poll
      const target = match ?? (canFallback ? latest : undefined)
      if (!target) return true
      if (fresh.has(target)) target.line.details?.push(detail.text)
      else
        trailing.push({
          kind: 'step-detail',
          text: `${target.line.label} ${target.call}: ${detail.text}`,
          ...(target.line.role ? { role: target.line.role } : {})
        })
      return false
    })
    previousSteps.push(...steps)
    return trailing
  }

  return {
    /** `through` is the newest driver-log time already printed as narration: records at or before it are not printed again. */
    render(
      update: Pick<ReaderUpdate, 'records' | 'gaps'>,
      rawDetails: readonly string[],
      now: Date,
      backlog: boolean,
      through = Number.NEGATIVE_INFINITY
    ) {
      const lines: DriverLogLine[] = update.gaps.map((gap) => ({
        kind: 'runner',
        at: now.getTime(),
        text: `Log gap (${gap.kind}) at ${gap.place}: ${gap.detail}`
      }))
      const steps: Step[] = []
      for (const record of update.records) {
        if (record.attributes[A.provenance] === 'reported') continue
        if (record.name !== E.agentStarted && !spanNamed(record, S.agent)) continue
        const id = word(record.attributes[A.agentId])
        const role = seat(record, undefined)
        const runId = word(record.attributes[A.runId])
        if (runId) agentsRunIds.set(record.traceId, runId)
        if (!id || !role) continue
        const run = agents.get(record.traceId) ?? new Map()
        run.set(id, role)
        agents.set(record.traceId, run)
      }
      const printed: DriverLogLine[] = []
      for (const record of update.records) {
        const translated = translate(record)
        if (!translated) continue
        if (timeOf(record) <= through) {
          printed.push(translated.line)
          continue
        }
        lines.push(translated.line)
        if (translated.step) steps.push(translated.step)
      }
      // Lines the driver-log view already printed still feed the stage and open actions, but print nothing.
      if (printed.length > 0) renderer.render(printed.map(escapeRecordLine), now, true)
      lines.unshift(...attachDetails(rawDetails, steps, through))
      return renderer.render(lines.map(escapeRecordLine), now, backlog)
    },
    tick: renderer.tick
  }
}
