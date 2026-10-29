/**
 * What `vinaya task status --follow` shows: the task's driver log, turned line
 * by line into one readable line per actor. The driver log on disk is never
 * changed by any of this — the view only chooses what to show and how.
 *
 * The renderer (`createFollowView`) is pure: it is handed the file's lines and
 * the current time, reads no clock and no file, and returns the lines to print.
 * Each line starts with the local wall-clock time; an agent line carries its
 * role's one fixed colour and the loop's own lines the loop's grey, behind the
 * same TTY and `NO_COLOR` gate dispatch uses (the caller decides, the renderer
 * only obeys `colour`). A detail that is the shell command, and the driver's
 * terminal copy of its own lines, are left out; every other detail is shown
 * dimmed. An action's start and its finish are paired by the action's own call
 * identifier: in the stretch of the log already written when the follow starts
 * a finished action is one line, and a live action's finish is a second line of
 * its own, since a follower only appends. A stage-change record becomes a banner
 * with the stage's typical length on this machine, and the follow loop's poll
 * tick appends a still-in-stage line every five minutes, and one more once the
 * stage passes twice its typical length. A line the renderer does not recognise
 * is shown with its time and the loop's colour, its words as written.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Role } from '@attalabs/aeg-core'
import { type AgentLineMark, formatAgentLine, parseLineMeta } from './agent-line.js'
import { ANSI_RESET, LOOP_ANSI, ROLE_ANSI } from './dispatch.js'
import { loopLogPathFor } from './loop-log.js'

// --- stages -----------------------------------------------------------------

/** The stages a version-2 run moves between, each with the words a reader sees. */
export const STAGES = {
  develop: 'develop',
  local_checks: 'local checks',
  review: 'review',
  ready_push: 'ready push',
  focused_checks: 'focused checks at ready',
  pr_opened: 'pull request opened',
  required_ci: 'waiting on required CI',
  waiting_merge: 'waiting for merge',
  paused_developer: 'paused for the Developer',
  paused_operator: 'paused for the Operator',
  paused_principal: 'paused for the Principal'
} as const

export type Stage = keyof typeof STAGES

/** Who must act on a paused stage. */
export const PAUSED_STAGE_ACTOR: Readonly<Partial<Record<Stage, string>>> = {
  paused_developer: 'the Developer',
  paused_operator: 'the Operator',
  paused_principal: 'the Principal'
}

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && Object.hasOwn(STAGES, value)
}

/** The mark on a stage that has already run past twice what it typically takes here. */
export const OVER_TYPICAL_MARK = '⚠'

/** How often a lasting stage is reported, in minutes. */
export const STILL_IN_STAGE_EVERY_MINUTES = 5

/** At most this many merged tasks' driver logs feed a stage's typical length. */
export const STAGE_HISTORY_LOGS = 20

/** Fewer samples than this, and a stage's typical length is unavailable. */
export const STAGE_HISTORY_MIN_SAMPLES = 3

export interface StageChange {
  round: number
  stage: Stage
  /** The pause reason the driver recorded, for a paused stage. */
  reason?: string
}

/** The stage-change record the version-2 driver writes into its driver log: plain words, the stage in the metadata. */
export function formatStageLine(change: StageChange, now: Date = new Date()): string {
  const words = `Round ${change.round}: ${STAGES[change.stage]}${change.reason ? ` (${change.reason})` : ''}.`
  return formatAgentLine('dev-review-loop', words, {
    log: true,
    unicode: false,
    mark: 'round',
    now,
    meta: { stage: change.stage, round: String(change.round), ...(change.reason ? { reason: change.reason } : {}) }
  })
}

// --- reading one driver-log line --------------------------------------------

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?: \[([^\]]*)\])? {2}(.*)$/
const PRIMARY = /^([>+x~#]) (\S(?:.*?\S)?) {3}(.*)$/
const TERMINAL_COPY = /^(?:\d{2}:\d{2}:\d{2} {2}[>+x~#▸✓✕◌◆] | {2}· )/

const ASCII_MARKS: Record<string, AgentLineMark> = {
  '>': 'working',
  '+': 'done',
  x: 'failed',
  '~': 'waiting',
  '#': 'round'
}
const VIEW_MARKS: Record<AgentLineMark, string> = { working: '▸', done: '✓', failed: '✕', waiting: '◌', round: '◆' }

export type DriverLogLine =
  | {
      kind: 'primary'
      at: number
      meta: Record<string, string | true>
      mark: AgentLineMark
      label: string
      words: string
    }
  | { kind: 'detail'; at: number; meta: Record<string, string | true>; text: string }
  /** The runner's own narration: an ISO time and plain words, no mark. */
  | { kind: 'runner'; at: number; text: string }
  /** The driver's terminal copy of a line the file already holds. */
  | { kind: 'copy' }
  | { kind: 'untimed'; text: string }
  | { kind: 'blank' }

export function parseDriverLogLine(line: string): DriverLogLine {
  if (line.trim() === '') return { kind: 'blank' }
  const timed = ISO.exec(line)
  if (timed !== null) {
    const at = Date.parse(timed[1] as string)
    const meta = timed[2] === undefined ? {} : parseLineMeta(timed[2])
    const rest = timed[3] as string
    if (rest.startsWith('· ')) return { kind: 'detail', at, meta, text: rest.slice(2) }
    const primary = PRIMARY.exec(rest)
    if (primary !== null)
      return {
        kind: 'primary',
        at,
        meta,
        mark: ASCII_MARKS[primary[1] as string] as AgentLineMark,
        label: primary[2] as string,
        words: primary[3] as string
      }
    return { kind: 'runner', at, text: rest }
  }
  if (TERMINAL_COPY.test(line)) return { kind: 'copy' }
  return { kind: 'untimed', text: line }
}

/** A process's own start record (`run started` or `Resumed`): nothing begun before it finishes after it. */
function isRunStart(line: DriverLogLine): boolean {
  return line.kind === 'primary' && line.mark === 'round' && (line.words === 'run started' || line.words === 'Resumed')
}

/** The driver's own ending record: the exit line every runner writes last, or a cancel. */
function isEnding(line: DriverLogLine): boolean {
  return (
    line.kind === 'runner' &&
    (line.text.startsWith('driver exited (') || line.text === 'the pause was cancelled; ending')
  )
}

/** The published watch's or the halted watch's line for a pull request that merged. */
function isMergedEnding(line: DriverLogLine): boolean {
  return (
    line.kind === 'runner' &&
    (/^PR #\d+ was merged; ending$/.test(line.text) ||
      line.text === 'the pull request was merged while the run was halted; ending')
  )
}

function stageOf(line: DriverLogLine): (StageChange & { at: number }) | null {
  if (line.kind !== 'primary' || !isStage(line.meta.stage)) return null
  const round = Number(line.meta.round)
  if (!Number.isInteger(round) || round < 1) return null
  const reason = typeof line.meta.reason === 'string' ? line.meta.reason : undefined
  return { stage: line.meta.stage, round, at: line.at, ...(reason ? { reason } : {}) }
}

/** The newest stage-change record in a driver log, and whether the run ended after it; null before any. */
export function newestStage(lines: readonly string[]): (StageChange & { at: number; ended: boolean }) | null {
  let newest: (StageChange & { at: number; ended: boolean }) | null = null
  for (const raw of lines) {
    const line = parseDriverLogLine(raw)
    const stage = stageOf(line)
    if (stage !== null) newest = { ...stage, ended: false }
    else if (newest !== null && (isEnding(line) || isRunStart(line))) newest.ended = true
  }
  return newest
}

// --- typical stage length, from this machine's merged tasks -----------------

export interface StageSample {
  stage: Stage
  minutes: number
}

/** Each stage interval in one driver log (a stage line to the next, or to the run's ending), and whether it merged. */
export function stageSamplesOf(lines: readonly string[]): { merged: boolean; samples: StageSample[] } {
  const samples: StageSample[] = []
  let merged = false
  let open: { stage: Stage; at: number } | null = null
  const close = (at: number) => {
    if (open !== null && at >= open.at) samples.push({ stage: open.stage, minutes: (at - open.at) / 60_000 })
    open = null
  }
  for (const raw of lines) {
    const line = parseDriverLogLine(raw)
    if (isMergedEnding(line)) merged = true
    const stage = stageOf(line)
    if (stage !== null) {
      close(stage.at)
      open = { stage: stage.stage, at: stage.at }
    } else if ((isEnding(line) || isRunStart(line)) && 'at' in line) {
      close(line.at)
    }
  }
  return { merged, samples }
}

export type StageHistory = Readonly<Partial<Record<Stage, { medianMinutes: number; samples: number }>>>

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Each stage's median across the given logs (newest first): only merged logs with stage lines, at most twenty. */
export function stageHistoryOf(logs: Iterable<readonly string[]>): StageHistory {
  const byStage = new Map<Stage, number[]>()
  let used = 0
  for (const lines of logs) {
    if (used >= STAGE_HISTORY_LOGS) break
    const { merged, samples } = stageSamplesOf(lines)
    if (!merged || samples.length === 0) continue
    used += 1
    for (const sample of samples) byStage.set(sample.stage, [...(byStage.get(sample.stage) ?? []), sample.minutes])
  }
  const out: Partial<Record<Stage, { medianMinutes: number; samples: number }>> = {}
  for (const [stage, minutes] of byStage) out[stage] = { medianMinutes: median(minutes), samples: minutes.length }
  return out
}

/**
 * The typical stage lengths from the other tasks' driver logs under `root`, newest by modification time first. Read
 * lazily, one log at a time, so the reading stops once twenty merged logs with stage lines are counted. No forge read.
 */
export function readStageHistory(root: string, exceptIssue: number | null): StageHistory {
  let issues: number[] = []
  try {
    issues = readdirSync(join(root, 'tasks-execution'))
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .filter((issue) => issue !== exceptIssue)
  } catch {
    return {}
  }
  const logs = issues
    .map((issue) => {
      const path = loopLogPathFor(null, issue, root)
      try {
        return { path, mtime: statSync(path).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((log): log is { path: string; mtime: number } => log !== null)
    .sort((a, b) => b.mtime - a.mtime)
  function* read(): Generator<string[]> {
    for (const log of logs) {
      try {
        yield readFileSync(log.path, 'utf8').split('\n')
      } catch {
        // An unreadable log is no sample.
      }
    }
  }
  return stageHistoryOf(read())
}

/** A stage's typical minutes, or null when fewer than three samples exist. */
export function typicalMinutes(history: StageHistory, stage: Stage): number | null {
  const entry = history[stage]
  return entry !== undefined && entry.samples >= STAGE_HISTORY_MIN_SAMPLES ? entry.medianMinutes : null
}

// --- the view ----------------------------------------------------------------

export interface FollowViewOptions {
  /** Colour on: the caller's TTY and `NO_COLOR` gate decided it. */
  colour: boolean
  /** Detail lines shown; `--quiet` turns them off. */
  details: boolean
  /** Absolute directories (the repository and its worktrees) whose paths are shown relative to them. */
  roots?: readonly string[]
  /** The typical stage lengths; empty reads as typical unavailable. */
  history?: StageHistory
  /** The time zone the clock time is shown in; the machine's own when absent. */
  timeZone?: string
}

export interface FollowView {
  /** The lines the file already held when the follow started. */
  backlog(lines: readonly string[], now: Date): string[]
  /** Lines appended after that, as they arrive. */
  push(lines: readonly string[], now: Date): string[]
  /** One poll of the follow loop: a still-in-stage or over-typical line when one is due. */
  tick(now: Date): string[]
}

const LABEL_ROLES: Readonly<Record<string, Role>> = {
  Developer: 'developer',
  'Code review': 'code-reviewer',
  'Code Reviewer': 'code-reviewer',
  Security: 'security',
  'Security Reviewer': 'security',
  Principal: 'principal',
  Planner: 'planner',
  Archivist: 'archivist',
  Architect: 'architect'
}

const DIM = '\x1b[2m'
const DETAIL_INDENT = ' '.repeat(10)

interface OpenAction {
  at: number
  label: string
}

interface OpenStage extends StageChange {
  at: number
  /** The last five-minute mark a still-in-stage line was written for. */
  reported: number
  overTypical: boolean
}

export function createFollowView(options: FollowViewOptions): FollowView {
  const history = options.history ?? {}
  const roots = [...(options.roots ?? [])].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)
  const open = new Map<string, OpenAction>()
  let stage: OpenStage | null = null
  let lastAt: number | null = null

  const clock = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-GB', {
      hour12: false,
      hourCycle: 'h23',
      ...(options.timeZone ? { timeZone: options.timeZone } : {})
    })

  const relative = (text: string): string => {
    let out = text
    for (const root of roots) out = out.split(`${root}/`).join('').split(root).join('.')
    return out
  }

  const paint = (text: string, role: Role | null, dim = false): string => {
    if (!options.colour) return text
    return `${dim ? DIM : ''}${role === null ? LOOP_ANSI : ROLE_ANSI[role]}${text}${ANSI_RESET}`
  }

  const primaryLine = (at: number, mark: AgentLineMark, label: string, words: string): string =>
    paint(`${clock(at)}  ${VIEW_MARKS[mark]} ${label}   ${relative(words)}`, LABEL_ROLES[label] ?? null)

  const loopLine = (at: number, words: string, mark: AgentLineMark = 'working'): string =>
    paint(`${clock(at)}  ${VIEW_MARKS[mark]} Loop   ${relative(words)}`, null)

  const detailLine = (text: string, label: string | null): string =>
    paint(`${DETAIL_INDENT}· ${relative(text)}`, label === null ? null : (LABEL_ROLES[label] ?? null), true)

  const typicalText = (s: Stage): string => {
    const typical = typicalMinutes(history, s)
    return typical === null ? 'typical unavailable' : `typical ${Math.round(typical)}m`
  }

  const banner = (change: StageChange & { at: number }): string => {
    const actor = PAUSED_STAGE_ACTOR[change.stage]
    const parts = [`Round ${change.round}`, STAGES[change.stage]]
    if (actor !== undefined) parts.push(change.reason ?? 'no reason recorded', `${actor} must act`)
    parts.push(typicalText(change.stage))
    return loopLine(change.at, `━━ ${parts.join(' · ')} ━━`, 'round')
  }

  /** Follows one parsed line's effect on the stage and the open actions; returns a banner for a stage change. */
  const track = (line: DriverLogLine): string | null => {
    if (isRunStart(line)) open.clear()
    const change = stageOf(line)
    if (change !== null) {
      stage = { ...change, reported: 0, overTypical: false }
      return banner(change)
    }
    if (stage !== null && (isEnding(line) || isRunStart(line))) stage = null
    return null
  }

  /** One line as it reads on its own: its time, its actor's colour, its words. */
  const plain = (line: DriverLogLine, now: Date): string[] => {
    switch (line.kind) {
      case 'primary':
        return [primaryLine(line.at, line.mark, line.label, line.words)]
      case 'runner':
        return [loopLine(line.at, line.text)]
      case 'untimed':
        return [loopLine(lastAt ?? now.getTime(), line.text)]
      default:
        return []
    }
  }

  /** A detail beneath its primary: none for the shell command, none under `--quiet`. */
  const detail = (line: DriverLogLine & { kind: 'detail' }, owner: string | null): string[] =>
    options.details && line.meta.command !== true ? [detailLine(line.text, owner)] : []

  const callOf = (line: DriverLogLine): string | null =>
    line.kind === 'primary' && typeof line.meta.call === 'string' ? line.meta.call : null

  const isFinish = (line: DriverLogLine): boolean =>
    line.kind === 'primary' && (line.mark === 'done' || line.mark === 'failed')

  const render = (lines: readonly string[], now: Date, backlog: boolean): string[] => {
    const parsed = lines.map(parseDriverLogLine)
    // A line with no time of its own (the launch's header) takes the time of the line before it, or else the next.
    if (lastAt === null) {
      const first = parsed.find((line) => 'at' in line)
      if (first !== undefined && 'at' in first) lastAt = first.at
    }
    // In the backlog, a start whose finish is already written is shown once, as its finish, at its start's place.
    const finishOf = new Map<number, number>()
    if (backlog) {
      const starts = new Map<string, number>()
      parsed.forEach((line, index) => {
        if (isRunStart(line)) starts.clear()
        const call = callOf(line)
        if (call === null || line.kind !== 'primary') return
        if (line.mark === 'working') starts.set(call, index)
        else if (isFinish(line) && starts.has(call)) {
          finishOf.set(starts.get(call) as number, index)
          starts.delete(call)
        }
      })
    }
    const finished = new Set(finishOf.values())
    const out: string[] = []
    // The actor whose details follow, and whether they were already shown with their action's one line.
    let owner: string | null = null
    let shown = false
    parsed.forEach((line, index) => {
      if (line.kind === 'copy' || line.kind === 'blank') return
      if (line.kind === 'detail') {
        if (!shown) out.push(...detail(line, owner))
        return
      }
      if ('at' in line) lastAt = line.at
      shown = finished.has(index)
      // A finish already shown as its action's one line, at its start's place, with its details.
      if (shown) return
      owner = line.kind === 'primary' ? line.label : null
      const bannerLine = track(line)
      if (bannerLine !== null) {
        out.push(bannerLine)
        return
      }
      const call = callOf(line)
      if (line.kind === 'primary' && call !== null) {
        const finishIndex = finishOf.get(index)
        if (finishIndex !== undefined) {
          const finish = parsed[finishIndex] as DriverLogLine & { kind: 'primary' }
          out.push(primaryLine(line.at, finish.mark, line.label, finish.words))
          // The finish's own details (a failure's first line) follow the one line, in place of the start's.
          const after = parsed.slice(finishIndex + 1)
          for (const next of after) {
            if (next.kind !== 'detail') break
            out.push(...detail(next, line.label))
          }
          return
        }
        if (line.mark === 'working') open.set(call, { at: line.at, label: line.label })
        else if (isFinish(line) && open.has(call)) {
          const started = open.get(call) as OpenAction
          open.delete(call)
          out.push(primaryLine(line.at, line.mark, line.label, `${line.words} (started ${clock(started.at)})`))
          return
        }
      }
      out.push(...plain(line, now))
    })
    return out
  }

  return {
    backlog: (lines, now) => render(lines, now, true),
    push: (lines, now) => render(lines, now, false),
    tick(now) {
      if (stage === null) return []
      const elapsedMs = now.getTime() - stage.at
      if (elapsedMs < 0) return []
      const minutes = Math.floor(elapsedMs / 60_000)
      const out: string[] = []
      const mark = Math.floor(minutes / STILL_IN_STAGE_EVERY_MINUTES)
      if (mark >= 1 && mark > stage.reported) {
        stage.reported = mark
        out.push(
          loopLine(now.getTime(), `Still in ${STAGES[stage.stage]} (round ${stage.round}) after ${minutes}m`, 'waiting')
        )
      }
      const typical = typicalMinutes(history, stage.stage)
      if (!stage.overTypical && typical !== null && typical > 0 && elapsedMs > 2 * typical * 60_000) {
        stage.overTypical = true
        out.push(
          loopLine(
            now.getTime(),
            `Still in ${STAGES[stage.stage]} (round ${stage.round}) after ${minutes}m ${OVER_TYPICAL_MARK} past twice its typical ${Math.round(typical)}m`,
            'waiting'
          )
        )
      }
      return out
    }
  }
}

/** Splits arriving bytes into whole lines: a trailing partial line waits for its newline, and a multibyte character split across chunks stays whole. */
export function lineSplitter(): (chunk: Buffer) => string[] {
  const decoder = new TextDecoder('utf-8')
  let pending = ''
  return (chunk) => {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split('\n')
    pending = lines.pop() ?? ''
    return lines
  }
}
