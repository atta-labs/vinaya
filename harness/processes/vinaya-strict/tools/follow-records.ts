import { readdir } from 'node:fs/promises'
import {
  ATTRIBUTE_NAMES as A,
  EVENT_NAMES as E,
  SPAN_NAMES as S
} from '../../../../packages/log-sdk/src/contract/catalogue.js'
import { spanIdFor } from '../../../../packages/log-sdk/src/contract/ids.js'
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
type Detail = { at: number; call?: string; label: string; text: string }

export function createRecordFollow(options: FollowViewOptions) {
  const renderer = createFollowRenderer(options)
  const seatNames = Object.fromEntries(
    registeredRoles().flatMap((name) => {
      const role = lookupRole(name)
      return role === undefined ? [] : [[name, role] as const]
    })
  )
  const agents = new Map<string, Map<string, string>>()
  const earlier = new Map<string, OtelRecord[]>()
  const pauseReasons = new Map<string, string>()
  const previousSteps: Step[] = []
  let pending: Detail[] = []
  let owner: Primary | undefined

  function seat(record: OtelRecord, call: string | undefined): Role | undefined {
    const a = record.attributes
    const direct = word(a[A.agentName]) ?? word(a[A.seat])
    if (direct !== undefined && lookupRole(direct)) return direct as Role
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
    if (record.name === E.runStarted || record.name === E.cancelled) return { line: { kind: 'reset' } }
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
      const role = seat(record, call)
      const errorType = word(a[A.errorType])
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
          : renderNarratedUpdate({ type: 'action', id: call, kind, subject, at })
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
        endsStage: record.name === E.exited
      }
    }
  }

  function attachDetails(raw: readonly string[], steps: Step[]): DriverLogLine[] {
    if (!options.details) return []
    for (const text of raw) {
      const line = parseDriverLogLine(text)
      if (line.kind === 'primary') owner = line
      else if (line.kind === 'runner' || line.kind === 'untimed') owner = undefined
      else if (line.kind === 'detail' && owner) {
        const call = word(line.meta.call) ?? word(owner.meta.call)
        pending.push({ at: owner.at, label: owner.label, text: line.text, ...(call ? { call } : {}) })
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
      const target = match ?? latest
      if (!target) return true
      if (fresh.has(target)) target.line.details?.push(detail.text)
      else
        trailing.push({
          kind: 'step-detail',
          text: detail.text,
          ...(target.line.role ? { role: target.line.role } : {})
        })
      return false
    })
    previousSteps.push(...steps)
    return trailing
  }

  return {
    render(update: Pick<ReaderUpdate, 'records' | 'gaps'>, rawDetails: readonly string[], now: Date, backlog: boolean) {
      const lines: DriverLogLine[] = update.gaps.map((gap) => ({
        kind: 'runner',
        at: now.getTime(),
        text: `Log gap (${gap.kind}) at ${gap.place}: ${gap.detail}`
      }))
      const steps: Step[] = []
      for (const record of update.records) {
        if (record.name !== E.agentStarted && !spanNamed(record, S.agent)) continue
        const id = word(record.attributes[A.agentId])
        const role = seat(record, undefined)
        if (!id || !role) continue
        const run = agents.get(record.traceId) ?? new Map()
        run.set(id, role)
        agents.set(record.traceId, run)
      }
      for (const record of update.records) {
        const translated = translate(record)
        if (!translated) continue
        lines.push(translated.line)
        if (translated.step) steps.push(translated.step)
      }
      lines.unshift(...attachDetails(rawDetails, steps))
      return renderer.render(lines, now, backlog)
    },
    tick: renderer.tick
  }
}
