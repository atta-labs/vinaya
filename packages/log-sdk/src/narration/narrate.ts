import { ATTRIBUTE_NAMES as A, EARLIER_EVENT_PREFIX, EVENT_NAMES as E, SPAN_NAMES as S } from '../contract/catalogue.js'
import {
  type ConfidenceRead,
  checksLine,
  codeOf,
  confidenceClause,
  conflictReentryLine,
  dispatchedLine,
  driverExitedLine,
  type NarrationLine,
  pausedForValue,
  pausedLine,
  roundEndedLine,
  roundStartedLine,
  stoppedLine,
  subjectFor,
  textOf,
  turnEndedLine,
  type VerdictEntry,
  verdictsLine,
  wholeOf
} from './wording.js'

/** How the caller reads a seat: a reading name, or a reading name with whether the seat reviews. */
export type SeatNames = Readonly<Record<string, string | { reading: string; reviews?: boolean }>>

type Fields = Record<string, unknown>
type Shape = { kind: 'dev_review_loop' | 'dispatch'; event: string; fields: Fields; native: boolean }

/** The part of a record narration reads. */
export type NarratableRecord = {
  kind: string
  name: string
  startTime: string | null
  time: string
  attributes: Readonly<Record<string, unknown>>
}

/** The record's own stop rule names, back to the conditions the earlier format named. */
const CONDITION_OF_RULE: Record<string, string> = {
  approved: 'green',
  round_limit: 'max_rounds',
  no_progress: 'no_progress',
  escalated: 'escalated',
  person_stop: 'principal_stop',
  confidence: 'confidence',
  fixed_finding_returned: 'reappearance',
  same_finding: 'repeat_finding',
  same_failure: 'repeat_failure',
  time_budget: 'time_budget'
}

const REASON_OF_EXIT_KIND: Record<string, string> = {
  finished: 'finished',
  paused: 'paused',
  restarted: 'reexec',
  error: 'error',
  signal: 'signal'
}

function isRecord(value: unknown): value is NarratableRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<NarratableRecord>
  return (
    typeof record.name === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.attributes === 'object' &&
    record.attributes !== null
  )
}

function earlierFields(attributes: Readonly<Record<string, unknown>>): Fields | null {
  let found = false
  const fields: Fields = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith(EARLIER_EVENT_PREFIX)) continue
    found = true
    fields[key.slice(EARLIER_EVENT_PREFIX.length)] = value
  }
  return found ? fields : null
}

function milliseconds(record: NarratableRecord): number | null {
  if (record.startTime === null) return null
  try {
    const span = BigInt(record.time) - BigInt(record.startTime)
    return span >= 0n ? Number(span / 1_000_000n) : null
  } catch {
    return null
  }
}

/** Reads the record's own attributes into the fields the wording takes. */
function nativeFields(record: NarratableRecord, event: string): Fields {
  const a = record.attributes
  const round = wholeOf(a[A.roundNumber]) ?? wholeOf(a[A.round])
  switch (event) {
    case 'round_started':
      return { round }
    case 'gate_result_read':
      return { round, green: a[A.checksGreen] }
    case 'verdicts_read': {
      const seats = Array.isArray(a[A.seats]) ? (a[A.seats] as unknown[]) : []
      const verdicts = Array.isArray(a[A.verdicts]) ? (a[A.verdicts] as unknown[]) : []
      const reviewers = seats.map((role, index) => ({ role, outcome: verdicts[index] }))
      const blockers = wholeOf(a[A.blockingCount])
      return {
        round,
        blockers,
        reviewers,
        all_approve: blockers === 0 && reviewers.length > 0 && reviewers.every(({ outcome }) => outcome === 'approve')
      }
    }
    case 'round_ended':
      return { round, outcome: a[A.roundOutcome], wall_ms: milliseconds(record) }
    case 'paused':
      return { why: textOf(a[A.pauseWhy]) }
    case 'stop_condition_met': {
      const rule = textOf(a[A.rule])
      return { condition: rule === null ? null : (CONDITION_OF_RULE[rule] ?? rule) }
    }
    case 'driver_exited': {
      const kind = textOf(a[A.exitKind])
      return {
        reason: kind === null ? null : (REASON_OF_EXIT_KIND[kind] ?? kind),
        exit_code: a[A.exitCode],
        error_class: a[A.errorType]
      }
    }
    case 'conflict_reentry': {
      const change = textOf(a[A.change])
      return { pr: change !== null && /^\d+$/.test(change) ? Number(change) : null, attempt: a[A.changeReentry] }
    }
    case 'dispatched':
      return { target_role: a[A.agentName] ?? a[A.seat], round }
    default:
      return {
        target_role: a[A.agentName] ?? a[A.seat],
        round,
        outcome: { type: a[A.agentOutcome] }
      }
  }
}

function shapeOf(record: NarratableRecord): Shape | null {
  const { name } = record
  let kind: Shape['kind'] = 'dev_review_loop'
  let event: string | null = null
  if (name === E.roundStarted) event = 'round_started'
  else if (name === E.checkRead) event = 'gate_result_read'
  else if (name === E.reviewVerdicts) event = 'verdicts_read'
  else if (record.kind === 'span' && (name === S.round || name.startsWith(`${S.round} `))) event = 'round_ended'
  else if (name === E.pauseStarted) event = 'paused'
  else if (name === E.stopRuleMet) event = 'stop_condition_met'
  else if (name === E.exited) event = 'driver_exited'
  else if (name === E.changeConflicted) event = 'conflict_reentry'
  else if (name === E.agentStarted) {
    kind = 'dispatch'
    event = 'dispatched'
  } else if (record.kind === 'span' && (name === S.agent || name.startsWith(`${S.agent} `))) {
    // A failed agent turn has no wording of its own.
    if (record.attributes[A.errorType] !== undefined) return null
    kind = 'dispatch'
    event = 'outcome_received'
  }
  if (event === null) return null
  const earlier = earlierFields(record.attributes)
  // An agent turn converted from an earlier role attempt names its agent, not its seat; the span's own seat does.
  if (earlier !== null && kind === 'dispatch' && earlier.target_role == null) {
    const seat = record.attributes[A.agentName] ?? record.attributes[A.seat]
    if (seat != null) earlier.target_role = seat
  }
  return { kind, event, fields: earlier ?? nativeFields(record, event), native: earlier === null }
}

function seatSubject(seat: unknown, seatNames: SeatNames | undefined): string {
  const recorded = textOf(seat)
  if (recorded === null) return subjectFor(null)
  if (seatNames === undefined) return recorded
  const entry = Object.hasOwn(seatNames, recorded) ? seatNames[recorded] : undefined
  if (entry === undefined) return subjectFor(null)
  return subjectFor(typeof entry === 'string' ? entry : entry.reading)
}

function seatReviews(seat: unknown, seatNames: SeatNames | undefined): boolean {
  const recorded = textOf(seat)
  if (recorded === null || seatNames === undefined || !Object.hasOwn(seatNames, recorded)) return false
  const entry = seatNames[recorded]
  return typeof entry === 'object' && entry !== undefined && entry.reviews === true
}

/** What the round's own gate read recorded about confidence, from the records read before; `null` when none is there. */
function confidenceOf(shape: Shape, earlier: readonly unknown[]): string | null {
  let read: ConfidenceRead | null = null
  for (const candidate of earlier) {
    if (!isRecord(candidate)) continue
    const before = shapeOf(candidate)
    if (before?.event === 'gate_result_read' && !before.native) {
      const f = before.fields
      if (f.loop_id === shape.fields.loop_id && wholeOf(f.round) !== null && f.round === shape.fields.round) {
        read = {
          unavailable: f.confidence_unavailable === true,
          value: f.confidence_value,
          extraTurn: f.extra_turn_spent === true
        }
      }
    } else if (shape.native && candidate.name === E.confidenceStated) {
      const a = candidate.attributes
      const round = wholeOf(a[A.roundNumber]) ?? wholeOf(a[A.round])
      if (round !== null && round === shape.fields.round) {
        read = { unavailable: false, value: a[A.confidence], extraTurn: a[A.confidenceAfterExtraTurn] === true }
      }
    }
  }
  return confidenceClause(read)
}

function build(shape: Shape, seatNames: SeatNames | undefined, earlier: readonly unknown[]): NarrationLine | null {
  const f = shape.fields
  switch (shape.event) {
    case 'round_started':
      return roundStartedLine(wholeOf(f.round))
    case 'gate_result_read':
      return typeof f.green === 'boolean' ? checksLine(wholeOf(f.round), f.green) : null
    case 'verdicts_read': {
      const reviewers: VerdictEntry[] = []
      for (const entry of Array.isArray(f.reviewers) ? (f.reviewers as unknown[]) : []) {
        if (typeof entry !== 'object' || entry === null) continue
        const { role, outcome, blockers } = entry as Fields
        reviewers.push({ subject: seatSubject(role, seatNames), outcome, blockers: wholeOf(blockers) })
      }
      return verdictsLine({
        round: wholeOf(f.round),
        blockers: wholeOf(f.blockers),
        allApprove: f.all_approve === true,
        reviewers
      })
    }
    case 'round_ended':
      return roundEndedLine({
        round: wholeOf(f.round),
        wallMs: f.wall_ms,
        outcome: f.outcome,
        confidence: confidenceOf(shape, earlier)
      })
    case 'paused':
      return shape.native ? pausedForValue(textOf(f.why)) : pausedLine(codeOf(f.reason_code), textOf(f.reason))
    case 'stop_condition_met':
      return stoppedLine(f.condition)
    case 'driver_exited':
      return driverExitedLine({
        reason: f.reason,
        exitCode: wholeOf(f.exit_code),
        errorClass: codeOf(f.error_class)
      })
    case 'conflict_reentry':
      return conflictReentryLine({ pr: wholeOf(f.pr), attempt: wholeOf(f.attempt), bound: wholeOf(f.bound) })
    case 'dispatched':
      return dispatchedLine({
        subject: seatSubject(f.target_role, seatNames),
        reviewing: seatReviews(f.target_role, seatNames),
        round: wholeOf(f.round)
      })
    case 'outcome_received': {
      const outcome = f.outcome
      const escalated = typeof outcome === 'object' && outcome !== null && (outcome as Fields).type === 'escalation'
      return turnEndedLine({
        subject: seatSubject(f.target_role, seatNames),
        escalation: escalated ? { class: textOf((outcome as Fields).class) } : null
      })
    }
    default:
      return null
  }
}

/**
 * The one plain line for a record, or `null` when the record has no wording.
 * It never throws.
 *
 * `seatNames` is how the caller reads each seat; a seat it does not name
 * reads as "a role", and with no `seatNames` at all a seat is shown as
 * recorded. `earlier` is the records already read, used for one thing only: a
 * round end states the confidence recorded at the same round, because the
 * round end carries none of its own.
 */
export function narrate(
  record: unknown,
  seatNames?: SeatNames,
  earlier: readonly unknown[] = []
): NarrationLine | null {
  try {
    if (!isRecord(record)) return null
    const shape = shapeOf(record)
    return shape === null ? null : build(shape, seatNames, Array.isArray(earlier) ? earlier : [])
  } catch {
    return null
  }
}
