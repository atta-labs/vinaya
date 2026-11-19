/**
 * One plain line for one loop or dispatch record, so the terminal log and a
 * live screen use the same words. The kind carries the meaning; each consumer
 * adds its own time and styling. Every sentence is built by the Log SDK's
 * shared wording; this file reads an earlier-format record into the plain
 * values that wording takes, and a seat through the role registry.
 */

import {
  type ConfidenceRead,
  checksLine,
  codeOf,
  confidenceClause,
  conflictReentryLine,
  dispatchedLine,
  driverExitedLine,
  NARRATION_KINDS,
  type NarrationKind,
  type NarrationLine,
  pausedLine,
  reasonWaitsOn,
  roundEndedLine,
  roundStartedLine,
  stoppedLine,
  subjectFor,
  textOf,
  turnEndedLine,
  type VerdictEntry,
  verdictsLine,
  wholeOf
} from '../../../../packages/log-sdk/src/narration/wording'
import { lookupRole } from '../roles'

export { NARRATION_KINDS, reasonWaitsOn }
export type { NarrationKind, NarrationLine }

type Fields = Record<string, unknown>

/** The role as the record carries it, as a noun phrase; a role the Log does not know reads as "a role". */
function roleSubject(value: unknown): string {
  const known = typeof value === 'string' ? lookupRole(value) : undefined
  return subjectFor(known ? known.reading : null)
}

/** What the round's own gate read recorded about confidence; `null` when no gate read of the round was supplied. */
function confidenceOf(record: Fields, earlier: readonly unknown[]): string | null {
  let read: Fields | null = null
  for (const candidate of earlier) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const fields = candidate as Fields
    if (
      fields.event === 'gate_result_read' &&
      fields.loop_id === record.loop_id &&
      wholeOf(fields.round) !== null &&
      fields.round === record.round
    )
      read = fields
  }
  if (!read) return null
  const gate: ConfidenceRead = {
    unavailable: read.confidence_unavailable === true,
    value: read.confidence_value,
    extraTurn: read.extra_turn_spent === true
  }
  return confidenceClause(gate)
}

function verdicts(record: Fields): NarrationLine {
  const reviewers: VerdictEntry[] = []
  for (const entry of Array.isArray(record.reviewers) ? (record.reviewers as unknown[]) : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const { role, outcome, blockers } = entry as Fields
    reviewers.push({ subject: roleSubject(role), outcome, blockers: wholeOf(blockers) })
  }
  return verdictsLine({
    round: wholeOf(record.round),
    blockers: wholeOf(record.blockers),
    allApprove: record.all_approve === true,
    reviewers
  })
}

function dispatched(record: Fields): NarrationLine {
  const role = textOf(record.target_role)
  return dispatchedLine({
    subject: roleSubject(role),
    reviewing: role !== null && (lookupRole(role)?.reviews ?? false),
    round: wholeOf(record.round)
  })
}

function outcomeReceived(record: Fields): NarrationLine {
  const outcome = record.outcome
  const escalated = typeof outcome === 'object' && outcome !== null && (outcome as Fields).type === 'escalation'
  return turnEndedLine({
    subject: roleSubject(record.target_role),
    escalation: escalated ? { class: textOf((outcome as Fields).class) } : null
  })
}

/**
 * The one plain line for a record, or `null` when this record has no wording.
 *
 * `earlier` is the loop's records already read, in order. It is used for one
 * thing only: a round end states the confidence recorded at the same round's
 * gate read, because a round end record carries no confidence of its own.
 * Without it the round end says nothing about confidence.
 */
export function narrate(record: unknown, earlier: readonly unknown[] = []): NarrationLine | null {
  try {
    if (typeof record !== 'object' || record === null) return null
    const fields = record as Fields
    if (fields.kind === 'dispatch') {
      if (fields.event === 'dispatched') return dispatched(fields)
      if (fields.event === 'outcome_received') return outcomeReceived(fields)
      return null
    }
    if (fields.kind !== 'dev_review_loop') return null
    switch (fields.event) {
      case 'round_started':
        return roundStartedLine(wholeOf(fields.round))
      case 'gate_result_read':
        return typeof fields.green === 'boolean' ? checksLine(wholeOf(fields.round), fields.green) : null
      case 'verdicts_read':
        return verdicts(fields)
      case 'round_ended':
        return roundEndedLine({
          round: wholeOf(fields.round),
          wallMs: fields.wall_ms,
          outcome: fields.outcome,
          confidence: confidenceOf(fields, Array.isArray(earlier) ? earlier : [])
        })
      case 'paused':
        return pausedLine(codeOf(fields.reason_code), textOf(fields.reason))
      case 'stop_condition_met':
        return stoppedLine(fields.condition)
      case 'driver_exited':
        return driverExitedLine({
          reason: fields.reason,
          exitCode: wholeOf(fields.exit_code),
          errorClass: codeOf(fields.error_class)
        })
      case 'conflict_reentry':
        return conflictReentryLine({
          pr: wholeOf(fields.pr),
          attempt: wholeOf(fields.attempt),
          bound: wholeOf(fields.bound)
        })
      default:
        return null
    }
  } catch {
    return null
  }
}
