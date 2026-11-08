/**
 * Mission Control's reading: the Log's events in, one picture of every task
 * out (`./picture.ts`, rules in `./README.md`). Two pure functions and nothing
 * else move a picture: `reduce(picture, event)` reads one event, and
 * `tick(picture, now)` lets time pass. Neither reads a clock, the disk or the
 * network, and nothing here imports a Node built-in, because the Studio app
 * bundles this code; the only imports are the kernel Log's narration and the
 * normaliser's row type.
 *
 * It reads only the Log. A task enters the picture with its first
 * `dev_review_loop` record; dispatch and handoff records then add to a task
 * already in it. Every other family is read past.
 */

import { narrate, reasonWaitsOn } from '../../../../kernel/log/client/narration'
import type { DatasetRow } from '../../../../kernel/log/sync/row'
import {
  AMBER_AFTER_MS,
  type FeedLine,
  type FindingCounts,
  type Picture,
  PRESUMED_DEAD_AFTER_MS,
  type ReadingEvent,
  type ReviewerOutcome,
  type ReviewerVerdict,
  type RoundPicture,
  TASK_STATES,
  type TaskPicture,
  type TaskState
} from './picture'

type Fields = Record<string, unknown>

const PRINCIPAL = 'the Principal'
const LOOP = 'the loop'

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function fieldsOf(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null
}

/** The event as it was recorded — header, family, name and body — which is the shape the narration reads. */
function recordOf(row: DatasetRow): Fields {
  return { meta: row.header.meta, subject: row.header.subject, kind: row.kind, event: row.event, ...row.payload }
}

// ---------------------------------------------------------------------------
// The state rules

type Standing = Pick<TaskPicture, 'state' | 'amber' | 'reason' | 'decision'>

/** The one state a task is in at `now`, from its signals and its last sign. `now` `null` (no tick yet) reads as no silence at all. */
export function standingOf(task: TaskPicture, now: number | null): Standing {
  const { pause, handoff, stop, endedReady, exit } = task.signals
  if (handoff) return { state: 'needs_you', amber: false, reason: handoff.class, decision: null }
  if (pause) {
    const waitsOn = reasonWaitsOn(pause.code, pause.reason)
    const recorded = pause.code ?? pause.reason
    if (waitsOn === 'person') return { state: 'needs_you', amber: false, reason: recorded, decision: null }
    if (waitsOn === null) {
      return {
        state: 'needs_a_look',
        amber: false,
        reason: recorded,
        decision: exit?.lastDecision ?? recorded ?? 'paused'
      }
    }
  }
  if (stop) return { state: 'stopped_itself', amber: false, reason: stop.condition, decision: null }
  if (endedReady) return { state: 'ready_to_merge', amber: false, reason: null, decision: null }
  if (exit && exit.reason !== 'reexec') {
    // A driver that exited with nothing recorded that explains why: not
    // running, not silent, so a person reads its own last decision.
    return { state: 'needs_a_look', amber: false, reason: exit.reason, decision: exit.lastDecision }
  }
  const silence = now === null ? 0 : Math.max(0, now - task.lastSign)
  if (silence >= PRESUMED_DEAD_AFTER_MS) return { state: 'presumed_dead', amber: false, reason: null, decision: null }
  return { state: 'running', amber: silence >= AMBER_AFTER_MS, reason: null, decision: null }
}

function whoAndCommand(task: TaskPicture, state: TaskState): { whoActs: string; command: string | null } {
  const pr = task.pr
  switch (state) {
    case 'running':
      return { whoActs: LOOP, command: null }
    case 'ready_to_merge':
      return { whoActs: PRINCIPAL, command: pr === null ? null : `gh pr merge ${pr} --squash` }
    case 'presumed_dead':
      return { whoActs: PRINCIPAL, command: pr === null ? null : `vinaya dev-review-loop --resume ${pr}` }
    default:
      return { whoActs: PRINCIPAL, command: pr === null ? null : `vinaya pr rule ${pr} --file <ruling.md>` }
  }
}

function nowLineOf(task: TaskPicture, standing: Standing): string {
  const latest = task.feed.at(-1)?.text ?? null
  switch (standing.state) {
    case 'presumed_dead':
      return 'No sign of life for ten minutes or more, and no exit recorded.'
    case 'needs_a_look':
      return `Stopped for a reason this reading does not know: ${standing.decision}.`
    case 'running':
      return standing.amber ? 'No sign of life for five minutes or more.' : (latest ?? 'Running.')
    case 'needs_you':
      return latest ?? 'Waiting for a person.'
    case 'stopped_itself':
      return latest ?? `Stopped: ${standing.reason}.`
    case 'ready_to_merge':
      return latest ?? 'Ready to merge.'
  }
}

/** The task with its state and everything worked out from the state brought up to `now`. */
function settle(task: TaskPicture, now: number | null): TaskPicture {
  const standing = standingOf(task, now)
  return { ...task, ...standing, ...whoAndCommand(task, standing.state), nowLine: nowLineOf(task, standing) }
}

function ordered(tasks: TaskPicture[]): TaskPicture[] {
  return [...tasks].sort((a, b) => TASK_STATES.indexOf(a.state) - TASK_STATES.indexOf(b.state) || a.task - b.task)
}

// ---------------------------------------------------------------------------
// Reading one event into a task

function newTask(task: number, at: number): TaskPicture {
  return {
    task,
    title: null,
    state: 'running',
    amber: false,
    reason: null,
    decision: null,
    rounds: [],
    pr: null,
    nowLine: 'Running.',
    lastSign: at,
    whoActs: LOOP,
    command: null,
    feed: [],
    tokens: {},
    model: null,
    models: {},
    machine: null,
    reviewerRoles: [],
    loopIds: [],
    signals: { pause: null, handoff: null, stop: null, endedReady: false, exit: null },
    gateReads: {}
  }
}

function emptyRound(n: number): RoundPicture {
  return {
    n,
    startedAt: null,
    endedAt: null,
    wallMs: null,
    outcome: null,
    checksGreen: null,
    agents: {},
    confidence: null,
    reviewers: [],
    findings: null
  }
}

/** The task with round `n` replaced by what `change` makes of it (an empty round when it is new); rounds stay in number order. */
function withRound(task: TaskPicture, n: number, change: (round: RoundPicture) => RoundPicture): TaskPicture {
  const existing = task.rounds.find((r) => r.n === n)
  const next = change(existing ?? emptyRound(n))
  const rounds = existing ? task.rounds.map((r) => (r.n === n ? next : r)) : [...task.rounds, next]
  return { ...task, rounds: rounds.sort((a, b) => a.n - b.n) }
}

function countFindings(findings: unknown): FindingCounts {
  const counts: FindingCounts = { blocking: 0, nonBlocking: 0, unclassified: 0, severities: {} }
  if (!Array.isArray(findings)) return counts
  for (const entry of findings) {
    const finding = fieldsOf(entry)
    if (!finding) continue
    if (finding.policy_treatment === 'blocking') counts.blocking += 1
    else if (finding.policy_treatment === 'non_blocking') counts.nonBlocking += 1
    else counts.unclassified += 1
    const severity = text(finding.severity)
    if (severity) counts.severities[severity] = (counts.severities[severity] ?? 0) + 1
  }
  return counts
}

function upsertReviewer(reviewers: ReviewerVerdict[], verdict: ReviewerVerdict): ReviewerVerdict[] {
  const rest = reviewers.filter((r) => r.role !== verdict.role)
  return [...rest, verdict].sort((a, b) => a.role.localeCompare(b.role))
}

/** A reviewer's own verdict, from its own dispatch outcome: the record names the reviewer, so its findings are its own. */
function reviewerFromDispatch(round: RoundPicture, role: string, outcome: Fields): RoundPicture {
  const word = outcome.verdict
  const verdict: ReviewerOutcome = word === 'APPROVE' || word === 'PASS' ? 'approve' : 'changes_requested'
  return {
    ...round,
    reviewers: upsertReviewer(round.reviewers, {
      role,
      outcome: verdict,
      findings: countFindings(outcome.findings),
      shared: false
    })
  }
}

/**
 * The round's verdicts as the loop read them. A reviewer whose own dispatch
 * already gave its findings keeps them. Otherwise a finding is credited to a
 * reviewer only when the record names that reviewer alone; with more than
 * one, every reviewer of the round shares the round's counts and one mark.
 */
function verdictsRead(round: RoundPicture, record: Fields, policyReviewers: string[]): RoundPicture {
  const findings = Array.isArray(record.findings) ? countFindings(record.findings) : null
  const listed = Array.isArray(record.reviewers)
    ? record.reviewers
        .map(fieldsOf)
        .filter((r): r is Fields => r !== null && typeof r.role === 'string')
        .map((r) => ({
          role: r.role as string,
          outcome: (r.outcome === 'approve' || r.outcome === 'not_reviewed'
            ? r.outcome
            : 'changes_requested') as ReviewerOutcome
        }))
    : null
  const mark: ReviewerOutcome = record.all_approve === true ? 'approve' : 'changes_requested'
  const entries = listed ?? policyReviewers.map((role) => ({ role, outcome: mark }))
  const alone = entries.length === 1
  let reviewers = round.reviewers
  for (const entry of entries) {
    const own = reviewers.find((r) => r.role === entry.role && !r.shared)
    if (own) {
      reviewers = upsertReviewer(reviewers, { ...own, outcome: listed ? entry.outcome : own.outcome })
      continue
    }
    reviewers = upsertReviewer(reviewers, {
      role: entry.role,
      outcome: entry.outcome,
      findings: alone ? findings : null,
      shared: !alone
    })
  }
  return { ...round, reviewers, findings }
}

function roundOf(record: Fields, row: DatasetRow): number | null {
  return whole(record.round) ?? row.round
}

function addFeed(task: TaskPicture, record: Fields, event: ReadingEvent): TaskPicture {
  const round = whole(record.round)
  const read = round === null ? undefined : task.gateReads[String(round)]
  const line = narrate(record, read ? [read] : [])
  if (!line) return task
  const entry: FeedLine = { position: event.position, at: event.receivedAt, kind: line.kind, text: line.text }
  return { ...task, feed: [...task.feed, entry] }
}

function addTokens(task: TaskPicture, role: string, usage: unknown): TaskPicture {
  const before = task.tokens[role] ?? { input: null, output: null, unknownTurns: 0 }
  const known = fieldsOf(usage)
  const input = typeof known?.input === 'number' ? known.input : null
  const output = typeof known?.output === 'number' ? known.output : null
  const after =
    input === null || output === null
      ? { ...before, unknownTurns: before.unknownTurns + 1 }
      : { input: (before.input ?? 0) + input, output: (before.output ?? 0) + output, unknownTurns: before.unknownTurns }
  return { ...task, tokens: { ...task.tokens, [role]: after } }
}

function withPr(task: TaskPicture, pr: unknown): TaskPicture {
  const n = whole(pr)
  return n !== null && n > 0 ? { ...task, pr: n } : task
}

function readLoopRecord(task: TaskPicture, record: Fields, row: DatasetRow, event: ReadingEvent): TaskPicture {
  let next: TaskPicture = { ...task, signals: { ...task.signals } }
  const signals = next.signals
  const loopId = text(record.loop_id)
  if (loopId && !next.loopIds.includes(loopId)) next.loopIds = [...next.loopIds, loopId]
  const machine = text((row.header.meta as Fields).machine)
  if (machine) next.machine = machine
  if (record.event !== 'driver_exited') signals.exit = null
  const round = roundOf(record, row)

  switch (record.event) {
    case 'loop_started': {
      const title = text(record.title)
      if (title) next.title = title
      const policy = fieldsOf(record.policy)
      if (policy) {
        if (Array.isArray(policy.reviewers)) {
          next.reviewerRoles = policy.reviewers.filter((r): r is string => typeof r === 'string')
        }
        const models = fieldsOf(policy.models)
        if (models) {
          const named: Record<string, string> = {}
          for (const [role, model] of Object.entries(models)) if (typeof model === 'string') named[role] = model
          next.models = { ...named, ...next.models }
          next.model = next.models.developer ?? next.model
        }
      }
      break
    }
    case 'round_started':
      signals.pause = null
      signals.stop = null
      signals.endedReady = false
      if (round !== null) next = withRound(next, round, (r) => ({ ...r, startedAt: r.startedAt ?? event.receivedAt }))
      break
    case 'gate_result_read':
      if (round !== null) {
        next = {
          ...next,
          gateReads: {
            ...next.gateReads,
            [String(round)]: {
              event: 'gate_result_read',
              loop_id: record.loop_id,
              round,
              confidence_value: record.confidence_value,
              confidence_unavailable: record.confidence_unavailable,
              extra_turn_spent: record.extra_turn_spent
            }
          }
        }
        const value = whole(record.confidence_value)
        const unavailable = record.confidence_unavailable === true
        next = withRound(next, round, (r) => ({
          ...r,
          checksGreen: typeof record.green === 'boolean' ? record.green : r.checksGreen,
          confidence:
            value !== null || unavailable
              ? { value, unavailable, extraTurnSpent: record.extra_turn_spent === true }
              : r.confidence
        }))
      }
      break
    case 'verdicts_read':
      if (round !== null) next = withRound(next, round, (r) => verdictsRead(r, record, next.reviewerRoles))
      break
    case 'round_ended':
      if (round !== null) {
        next = withRound(next, round, (r) => ({
          ...r,
          endedAt: event.receivedAt,
          wallMs: typeof record.wall_ms === 'number' ? record.wall_ms : r.wallMs,
          outcome:
            record.outcome === 'green' || record.outcome === 'changes_requested' || record.outcome === 'escalated'
              ? record.outcome
              : r.outcome
        }))
      }
      break
    case 'stop_condition_met': {
      const condition = text(record.condition)
      if (condition === 'green') signals.endedReady = true
      else if (condition) signals.stop = { condition }
      break
    }
    case 'journal_finalized':
      if (record.result === 'merged_ready') signals.endedReady = true
      break
    case 'paused':
      signals.pause = { code: text(record.reason_code), reason: text(record.reason) }
      break
    case 'resumed':
      signals.pause = null
      signals.stop = null
      break
    case 'cancelled':
      signals.pause = null
      signals.stop = { condition: 'cancelled' }
      break
    case 'conflict_reentry':
      signals.endedReady = false
      next = withPr(next, record.pr)
      break
    case 'driver_heartbeat':
    case 'pr_opened':
    case 'ci_result_read':
      next = withPr(next, record.pr)
      break
    case 'driver_exited': {
      const reason = text(record.reason) ?? 'unknown'
      signals.exit = { reason, lastDecision: typeof record.last_decision === 'string' ? record.last_decision : '' }
      if (reason === 'finished') signals.endedReady = true
      break
    }
    default:
      break
  }
  return next
}

function readDispatchRecord(task: TaskPicture, record: Fields, row: DatasetRow): TaskPicture {
  const role = text(record.target_role)
  if (!role) return task
  let next = task
  const model = text(record.model)
  if (model) {
    next = { ...next, models: { ...next.models, [role]: model } }
    if (role === 'developer') next = { ...next, model }
  }
  const round = roundOf(record, row)
  const setAgent = (state: RoundPicture['agents'][string]) => {
    if (round !== null) next = withRound(next, round, (r) => ({ ...r, agents: { ...r.agents, [role]: state } }))
  }
  if (record.event === 'dispatched') setAgent('working')
  else if (record.event === 'dispatch_failed') {
    setAgent('failed')
    next = addTokens(next, role, record.usage)
  } else if (record.event === 'outcome_received') {
    const outcome = fieldsOf(record.outcome)
    setAgent(outcome?.type === 'escalation' ? 'escalated' : 'done')
    next = addTokens(next, role, record.usage)
    if (outcome && (outcome.type === 'pr_opened' || outcome.type === 'round_pushed')) next = withPr(next, outcome.pr)
    if (outcome?.type === 'verdict' && round !== null) {
      next = withRound(next, round, (r) => reviewerFromDispatch(r, role, outcome))
    }
  }
  return next
}

function readHandoffRecord(task: TaskPicture, record: Fields): TaskPicture {
  const signals = { ...task.signals }
  if (record.event === 'raised') signals.handoff = { class: text(record.class) ?? 'handoff' }
  else if (record.event === 'resolved') signals.handoff = null
  return { ...task, signals }
}

/** The task a row belongs to: its Issue, else the task a loop record names, else the task its loop was started for. */
function taskOf(picture: Picture, row: DatasetRow, record: Fields): number | null {
  if (row.issue !== null) return row.issue
  const named = whole(record.task)
  if (named !== null) return named
  const loopId = text(record.loop_id)
  return loopId ? (picture.loops[loopId] ?? null) : null
}

// ---------------------------------------------------------------------------
// The two moves

/**
 * Reads one event into the picture. An event at a position already read
 * changes nothing but the repeat count; a line the normaliser could not read
 * is counted and skipped. State is worked out against the picture's own
 * `now`, which only `tick` moves.
 */
export function reduce(picture: Picture, event: ReadingEvent): Picture {
  if (picture.readThrough !== null && event.position <= picture.readThrough) {
    return { ...picture, repeated: picture.repeated + 1 }
  }
  const read: Picture = { ...picture, readThrough: event.position }
  if (event.line.type !== 'row') return { ...read, skipped: read.skipped + 1 }

  const row = event.line.row
  const family = row.kind
  if (family !== 'dev_review_loop' && family !== 'dispatch' && family !== 'handoff') return read
  const record = recordOf(row)
  const id = taskOf(read, row, record)
  if (id === null) return read
  const existing = read.tasks.find((t) => t.task === id)
  if (!existing && family !== 'dev_review_loop') return read

  let task = existing ?? newTask(id, event.receivedAt)
  task = { ...task, lastSign: Math.max(task.lastSign, event.receivedAt) }
  task = withPr(task, row.pr)
  if (family === 'dev_review_loop') task = readLoopRecord(task, record, row, event)
  else if (family === 'dispatch') task = readDispatchRecord(task, record, row)
  else task = readHandoffRecord(task, record)
  task = addFeed(task, record, event)

  const loopId = text(record.loop_id)
  const loops = loopId && read.loops[loopId] !== id ? { ...read.loops, [loopId]: id } : read.loops
  const others = read.tasks.filter((t) => t.task !== id)
  return { ...read, loops, tasks: ordered([...others, settle(task, read.now)]) }
}

/** Reads events in the order given; the same events in the same order always give the same picture. */
export function reduceAll(picture: Picture, events: Iterable<ReadingEvent>): Picture {
  let next = picture
  for (const event of events) next = reduce(next, event)
  return next
}

/**
 * Lets time pass: every task's state is worked out again at `now`, with no
 * event arriving. Returns the new picture and the tasks whose state or amber
 * warning changed. A `now` earlier than the picture's own changes nothing.
 */
export function tick(picture: Picture, now: number): { picture: Picture; changed: number[] } {
  if (picture.now !== null && now < picture.now) return { picture, changed: [] }
  const changed: number[] = []
  const tasks = picture.tasks.map((task) => {
    const next = settle(task, now)
    if (next.state !== task.state || next.amber !== task.amber) changed.push(task.task)
    return next
  })
  return { picture: { ...picture, now, tasks: ordered(tasks) }, changed: changed.sort((a, b) => a - b) }
}
