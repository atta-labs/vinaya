/**
 * Mission Control's picture: the shape the reading (`./reading.ts`) works the
 * Log's events into. Plain data only — no class, no function, no `Date` — so
 * a picture is copied, compared and sent over a stream as it is. Every time
 * is milliseconds since the epoch, as the caller handed it in; nothing here
 * reads a clock.
 *
 * The six states and the rules that pick one are in `./README.md`.
 */

import type { NarrationKind } from '../../../../kernel/log/client/narration'
import type { NormalizedLine } from '../../../../kernel/log/sync/row'

/** The six states, in the order a screen lists them: the first needs a person most. */
export const TASK_STATES = [
  'needs_you',
  'presumed_dead',
  'stopped_itself',
  'needs_a_look',
  'running',
  'ready_to_merge'
] as const
export type TaskState = (typeof TASK_STATES)[number]

/** A loop silent this long is shown with its amber warning while it still reads as running: one heartbeat interval. */
export const AMBER_AFTER_MS = 5 * 60_000
/** A loop silent this long, with no exit recorded, is presumed dead: two heartbeat intervals. */
export const PRESUMED_DEAD_AFTER_MS = 10 * 60_000

/**
 * One event as the reading takes it: the line the Log's normaliser produced
 * for it, its position in the Log, and the time it was received. Position is
 * the order — never the time.
 */
export type ReadingEvent = {
  position: number
  receivedAt: number
  line: NormalizedLine
}

/** Counts of a set of findings by how the review policy treated them, and by reported severity. Never a finding's text. */
export type FindingCounts = {
  blocking: number
  nonBlocking: number
  /** Findings whose record names no policy treatment: neither blocking nor non-blocking is claimed for them. */
  unclassified: number
  /** How many findings carried each reported severity, as reported. */
  severities: Record<string, number>
}

export type ReviewerOutcome = 'approve' | 'changes_requested' | 'not_reviewed'

/**
 * One reviewer's verdict in one round. `findings` is that reviewer's own
 * counts only when the record says which reviewer reported them; otherwise it
 * is `null`, `shared` is `true`, and the round's own `findings` hold the
 * counts every reviewer of the round shares.
 */
export type ReviewerVerdict = {
  role: string
  outcome: ReviewerOutcome
  findings: FindingCounts | null
  shared: boolean
}

/** What one role is doing in a round, from its dispatch records. */
export type AgentState = 'working' | 'done' | 'escalated' | 'failed'

/** The Developer's stated confidence at the round's gate read; `null` on the round when none was read. */
export type Confidence = {
  /** A whole number 0–100, or `null` when the statement was missing or malformed. */
  value: number | null
  unavailable: boolean
  extraTurnSpent: boolean
}

export type RoundPicture = {
  n: number
  startedAt: number | null
  endedAt: number | null
  /** The round's own wall time as its end record states it; `null` until it ends. */
  wallMs: number | null
  outcome: 'green' | 'changes_requested' | 'escalated' | null
  /** Whether the round's checks passed at its newest gate read; `null` before one. */
  checksGreen: boolean | null
  agents: Record<string, AgentState>
  confidence: Confidence | null
  reviewers: ReviewerVerdict[]
  /** Every finding of the round, from its verdicts read; `null` before one. */
  findings: FindingCounts | null
}

/** Tokens one role spent on this task, summed over its turns whose usage was recorded. */
export type RoleTokens = {
  /** `null` while no turn of the role recorded its usage — unknown, never zero. */
  input: number | null
  output: number | null
  /** Turns whose usage was not recorded: when above zero, the sums cover only part of the role's work. */
  unknownTurns: number
}

export type FeedLine = {
  position: number
  at: number
  kind: NarrationKind
  text: string
}

/** The facts the state rules read. Each is set and cleared by the events the README names. */
export type TaskSignals = {
  /** An open pause: its code and three-value reason, as recorded. */
  pause: { code: string | null; reason: string | null } | null
  /** An open handoff to a person, by its class. */
  handoff: { class: string } | null
  /** A stop condition met and not yet followed by a new round: its condition, as recorded. */
  stop: { condition: string } | null
  /** The loop ended ready: a green stop, a ready journal, or a finished driver. */
  endedReady: boolean
  /** The newest driver exit, while no other loop record came after it. */
  exit: { reason: string; lastDecision: string } | null
}

export type TaskPicture = {
  /** The task Issue. */
  task: number
  /** The task Issue's title as the loop recorded it at start; `null` when no start record carried one. */
  title: string | null
  state: TaskState
  /** A running task silent for five minutes or more. Only ever `true` while `state` is `running`. */
  amber: boolean
  /** Why the task is in its state, as recorded: the pause or stop code, or the handoff class. `null` when the state needs none. */
  reason: string | null
  /** For `needs_a_look` only: the loop's last decision, word for word. */
  decision: string | null
  rounds: RoundPicture[]
  pr: number | null
  /** One short line saying what is happening now. */
  nowLine: string
  /** When the newest event of this task was received. */
  lastSign: number
  /** Who has to act next: `'the Principal'`, or `'the loop'` while it runs on its own. */
  whoActs: string
  /** The exact command the one who acts runs, or `null` when the Log does not hold what a command would need. */
  command: string | null
  feed: FeedLine[]
  /** By role; a role appears once one of its turns returned. */
  tokens: Record<string, RoleTokens>
  /** The Developer's model: the newest one its dispatches named, else the one the loop's policy named. */
  model: string | null
  /** Every role's model, the same way. */
  models: Record<string, string>
  /** The machine the newest loop record came from. */
  machine: string | null
  /** The reviewer roles the loop's policy named; empty when no start record was read. */
  reviewerRoles: string[]
  /** The loops recorded for this task. */
  loopIds: string[]
  signals: TaskSignals
  /** The newest gate read of each round, kept so a round's end line states its confidence as the terminal does. */
  gateReads: Record<string, Record<string, unknown>>
}

export type Picture = {
  /** The time of the newest tick; `null` before the first. */
  now: number | null
  /** The highest position read; an event at or below it has already been read. */
  readThrough: number | null
  /** Lines the Log's normaliser could not read: skipped, never guessed. */
  skipped: number
  /** Events delivered again at a position already read: changed nothing. */
  repeated: number
  /** Every task, in state order, then by task number. */
  tasks: TaskPicture[]
  /** Which task each loop belongs to. */
  loops: Record<string, number>
}

export function emptyPicture(): Picture {
  return { now: null, readThrough: null, skipped: 0, repeated: 0, tasks: [], loops: {} }
}
