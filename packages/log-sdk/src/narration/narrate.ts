import { ATTRIBUTE_NAMES as A, EARLIER_EVENT_PREFIX, EVENT_NAMES as E, SPAN_NAMES as S } from '../contract/catalogue.js'
import {
  actionVerifiedLine,
  agentFailedLine,
  aliveLine,
  cancelledLine,
  changeClosedLine,
  changeIncidentLine,
  changeMergedLine,
  changeOpenedLine,
  changePushedLine,
  changeRecoveredLine,
  changeRevertedLine,
  changeSavedLine,
  checkNotPassedLine,
  checksEndedLine,
  commandCompletedLine,
  type ConfidenceRead,
  confidenceStatedLine,
  customEventLine,
  findingsComparedLine,
  forgeRefusedLine,
  forgeValidatedLine,
  forgeWrittenLine,
  pauseEndedLine,
  personAnsweredLine,
  personAskedLine,
  phaseEndedLine,
  retriedLine,
  runEndedLine,
  runStartedLine,
  stageChangedLine,
  stepEndedLine,
  stepStartedLine,
  usageRecordedLine,
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
      const blockers = wholeOf(a[A.blockingCount])
      // The record counts blocking findings for the whole round, so only a lone seat owns the whole count.
      const reviewers = seats.map((role, index) => ({
        role,
        outcome: verdicts[index],
        blockers: seats.length === 1 ? blockers : null
      }))
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

const CUSTOM_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/

function isSpanOf(record: NarratableRecord, base: string): boolean {
  return record.kind === 'span' && (record.name === base || record.name.startsWith(`${base} `))
}

/** The part a span's name adds after its base: `review` in `vinaya.phase review`. */
function partOf(record: NarratableRecord, base: string): string | null {
  return textOf(record.name.slice(base.length + 1))
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/** The pull request a record is about: its own change, else the change it is stamped with. */
function changeOf(a: Readonly<Record<string, unknown>>): string | null {
  const change = a[A.change] ?? a[A.workChange]
  const text = typeof change === 'number' ? String(change) : textOf(change)
  return text !== null && /^\d+$/.test(text) ? text : null
}

/** The parent agent's seat for a step: its started record among the records read before, by span id. */
function parentSeat(record: NarratableRecord, earlier: readonly unknown[]): unknown {
  const parent = textOf((record as { parentSpanId?: unknown }).parentSpanId)
  if (parent === null) return null
  for (const candidate of earlier) {
    if (!isRecord(candidate) || candidate.name !== E.agentStarted) continue
    if ((candidate as { spanId?: unknown }).spanId !== parent) continue
    return candidate.attributes[A.agentName] ?? candidate.attributes[A.seat]
  }
  return null
}

/** The lines for every record the earlier wording does not cover: the other events, and the span ends. */
function moreLines(
  record: NarratableRecord,
  seatNames: SeatNames | undefined,
  earlier: readonly unknown[]
): NarrationLine | null {
  const a = record.attributes
  const round = wholeOf(a[A.roundNumber]) ?? wholeOf(a[A.round])
  const failed = a[A.errorType] !== undefined
  const error = codeOf(a[A.errorType]) ?? (failed ? 'error' : null)
  if (record.kind === 'span') {
    if (isSpanOf(record, S.run)) return runEndedLine(textOf(a[A.runOutcome]))
    if (isSpanOf(record, S.pause)) return pauseEndedLine(codeOf(a[A.pauseBy]))
    if (isSpanOf(record, S.phase)) return phaseEndedLine(textOf(a[A.phaseName]) ?? partOf(record, S.phase), error)
    if (isSpanOf(record, S.agent))
      return agentFailedLine(seatSubject(a[A.agentName] ?? a[A.seat] ?? partOf(record, S.agent), seatNames), error)
    if (isSpanOf(record, S.step)) return stepEndedLine(textOf(a[A.toolName]) ?? partOf(record, S.step), error)
    if (isSpanOf(record, S.checks))
      return checksEndedLine({
        where: textOf(a[A.checkWhere]) ?? partOf(record, S.checks),
        result: textOf(a[A.result]),
        ran: wholeOf(a[A.checksRan]),
        failed: wholeOf(a[A.checksFailed])
      })
    if (isSpanOf(record, S.person)) return personAnsweredLine(codeOf(a[A.personAnswer]))
    return null
  }
  switch (record.name) {
    case E.runStarted:
      return runStartedLine()
    case E.alive:
      return aliveLine(round)
    case E.stageChanged:
      return stageChangedLine(textOf(a[A.stageTo]), round)
    case E.cancelled:
      return cancelledLine(codeOf(a[A.actor]))
    case E.retried:
      return retriedLine({
        failed: codeOf(a[A.retryFailed]),
        tries: wholeOf(a[A.retryTries]),
        recovered: a[A.retryRecovered] === true
      })
    case E.stepStarted:
      return stepStartedLine(
        seatSubject(parentSeat(record, earlier), seatNames),
        textOf(a[A.stepKind]),
        textOf(a[A.stepTarget])
      )
    case E.confidenceStated:
      return confidenceStatedLine(round, a[A.confidence])
    case E.usageRecorded:
      return usageRecordedLine({
        input: wholeOf(a[A.usageInputTokens]),
        output: wholeOf(a[A.usageOutputTokens]),
        unknownReason: codeOf(a[A.usageUnknownReason]),
        cost: typeof a[A.usageCost] === 'number' ? (a[A.usageCost] as number) : null,
        costKind: codeOf(a[A.usageCostKind]),
        costUnknownReason: codeOf(a[A.usageCostUnknownReason])
      })
    case E.findingsCompared:
      return findingsComparedLine({
        open: countOf(a[A.findingsOpen]),
        resolved: countOf(a[A.findingsResolved]),
        fresh: countOf(a[A.findingsNew]),
        recurring: countOf(a[A.findingsRecurring])
      })
    case E.checkNotPassed:
      return checkNotPassedLine(textOf(a[A.checkName]), codeOf(a[A.result]))
    case E.changeSaved:
      return changeSavedLine(textOf(a[A.branch]))
    case E.changePushed:
      return changePushedLine(textOf(a[A.result]))
    case E.changeOpened:
      return changeOpenedLine(changeOf(a))
    case E.changeRecovered:
      return changeRecoveredLine()
    case E.changeMerged:
      return changeMergedLine(changeOf(a))
    case E.changeClosed:
      return changeClosedLine(changeOf(a))
    case E.changeReverted:
      return changeRevertedLine(changeOf(a))
    case E.changeIncident:
      return changeIncidentLine(changeOf(a), codeOf(a[A.severity]))
    case E.personAsked:
      return personAskedLine(codeOf(a[A.personDecision]), codeOf(a[A.personWhy]))
    case E.forgeValidated:
      return forgeValidatedLine(codeOf(a[A.action]), textOf(a[A.target]))
    case E.forgeRefused:
      return forgeRefusedLine(codeOf(a[A.action]), textOf(a[A.target]), codeOf(a[A.reason]))
    case E.forgeWritten:
      return forgeWrittenLine(codeOf(a[A.action]), textOf(a[A.target]))
    case E.actionVerified:
      return actionVerifiedLine(codeOf(a[A.action]), textOf(a[A.target]), codeOf(a[A.result]))
    case E.commandCompleted:
      return commandCompletedLine(codeOf(a[A.action]), textOf(a[A.target]), codeOf(a[A.result]))
    default:
      return record.name.length <= 64 && !record.name.startsWith('vinaya.') && CUSTOM_NAME.test(record.name)
        ? customEventLine(record.name)
        : null
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
    const before = Array.isArray(earlier) ? earlier : []
    const shape = shapeOf(record)
    return shape === null ? moreLines(record, seatNames, before) : build(shape, seatNames, before)
  } catch {
    return null
  }
}
