/**
 * One plain line for one loop or dispatch record, so the terminal log and a
 * live screen use the same words. The kind carries the meaning; each consumer
 * adds its own time and styling.
 */

import { CODE_TOKEN_PATTERN, ROLE_VALUES } from './schema'

export const NARRATION_KINDS = [
  'starting',
  'working',
  'done',
  'failed',
  'waiting',
  'paused',
  'blocked',
  'information'
] as const
export type NarrationKind = (typeof NARRATION_KINDS)[number]

export type NarrationLine = { kind: NarrationKind; text: string }

type Fields = Record<string, unknown>

/** Why the loop stops or pauses, in words, and whether a person has to act. A reason absent from this table reads as paused, with its code. */
const REASONS: Record<string, { words: string; person: boolean }> = {
  escalation: { words: 'a role escalated a question', person: true },
  max_rounds: { words: 'the round limit was reached', person: true },
  no_progress: { words: 'the rounds made no progress', person: true },
  confidence: { words: 'the stated confidence collapsed', person: true },
  reappearance: { words: 'a finding marked resolved came back', person: true },
  repeat_finding: { words: 'the same blocking finding stayed open two rounds in a row', person: true },
  repeat_failure: { words: 'the same mechanical failure happened twice in a row', person: true },
  time_budget: { words: 'the time budget was passed', person: true },
  infrastructure: { words: 'a role or file the round needed was missing', person: true },
  no_push: { words: 'work was left unpushed', person: true },
  objectives_changed: { words: 'the objectives changed during the round', person: false },
  ruling_posted: { words: 'a ruling was posted during the round', person: false },
  stale_driver: { words: 'the base branch moved past the driver code', person: false },
  brief_superseded: { words: 'the brief was replaced during the round', person: false },
  policy_changed: { words: 'the review policy changed during the round', person: false },
  principal_stop: { words: 'an item needs a person to decide', person: true },
  escalated: { words: 'a role escalated a question', person: true }
}

/** Reasons a pause record names without a code. */
const PAUSE_WITHOUT_CODE: Record<string, string> = {
  escalation: 'escalation',
  principal_item: 'principal_stop'
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function code(value: unknown): string | null {
  return typeof value === 'string' && CODE_TOKEN_PATTERN.test(value) ? value : null
}

/** The role as the record carries it, spaced for reading and ready to start a sentence; a role the Log does not know reads as "A role". */
function roleSubject(value: unknown, sentenceStart = true): string {
  const name =
    typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value)
      ? `the ${value === 'security' ? 'security reviewer' : value.replace(/-/g, ' ')}`
      : 'a role'
  return sentenceStart ? `${name[0]?.toUpperCase()}${name.slice(1)}` : name
}

function roundLabel(record: Fields): string {
  const round = whole(record.round)
  return round === null ? 'The round' : `Round ${round}`
}

/** Minutes and seconds, rounded to the second. */
function duration(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function paused(reasonCode: string | null, fallbackReason: string | null): NarrationLine {
  const key = reasonCode ?? (fallbackReason ? (PAUSE_WITHOUT_CODE[fallbackReason] ?? null) : null)
  const known = key ? REASONS[key] : undefined
  if (known) {
    return known.person
      ? { kind: 'blocked', text: `The loop paused for a person: ${known.words}.` }
      : { kind: 'paused', text: `The loop paused itself: ${known.words}.` }
  }
  const named = reasonCode ?? code(fallbackReason)
  return { kind: 'paused', text: named ? `Paused: ${named}.` : 'Paused.' }
}

function stopped(condition: unknown): NarrationLine | null {
  const name = code(condition)
  if (!name) return null
  if (name === 'green') return { kind: 'done', text: 'The loop stopped: every check and review passed.' }
  const known = REASONS[name]
  if (!known) return { kind: 'information', text: `Stopped: ${name}.` }
  return known.person
    ? { kind: 'blocked', text: `The loop stopped itself: ${known.words}. A person has to act.` }
    : { kind: 'paused', text: `The loop stopped itself: ${known.words}.` }
}

/** What the round's own gate read recorded about confidence, in words; `null` when no gate read of the round was supplied, so nothing is claimed. */
function confidenceClause(record: Fields, earlier: readonly unknown[]): string | null {
  let read: Fields | null = null
  for (const candidate of earlier) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const fields = candidate as Fields
    if (
      fields.event === 'gate_result_read' &&
      fields.loop_id === record.loop_id &&
      whole(fields.round) !== null &&
      fields.round === record.round
    )
      read = fields
  }
  if (!read) return null
  if (read.confidence_unavailable === true) return 'Confidence: not given.'
  const value = read.confidence_value
  if (whole(value) !== null && (value as number) >= 0 && (value as number) <= 100)
    return `Confidence: ${value}${read.extra_turn_spent === true ? ' (after the extra turn)' : ''}.`
  return 'Confidence: —.'
}

function verdicts(record: Fields): NarrationLine {
  const label = roundLabel(record)
  const blockers = whole(record.blockers) ?? 0
  const reviewers = Array.isArray(record.reviewers) ? (record.reviewers as unknown[]) : []
  const parts: string[] = []
  for (const entry of reviewers) {
    if (typeof entry !== 'object' || entry === null) continue
    const { role, outcome, blockers: count } = entry as Fields
    const who = roleSubject(role, parts.length === 0)
    if (outcome === 'approve') parts.push(`${who} approved`)
    else if (outcome === 'changes_requested') parts.push(`${who} asked for changes (${whole(count) ?? 0} blocking)`)
    else if (outcome === 'not_reviewed') parts.push(`${who} did not review`)
  }
  const approved = record.all_approve === true
  const detail = parts.length > 0 ? parts.join('; ') : approved ? 'approved' : `${blockers} blocking`
  return { kind: approved ? 'done' : 'information', text: `${label} verdicts: ${detail}.` }
}

function roundEnded(record: Fields, earlier: readonly unknown[]): NarrationLine {
  const label = roundLabel(record)
  const took = duration(record.wall_ms)
  const outcome = record.outcome
  const [kind, words]: [NarrationKind, string] =
    outcome === 'green'
      ? ['done', 'approved']
      : outcome === 'changes_requested'
        ? ['information', 'changes requested']
        : outcome === 'escalated'
          ? ['blocked', 'a role escalated, a person has to decide']
          : ['information', 'ended']
  const confidence = confidenceClause(record, earlier)
  return {
    kind,
    text: `${label} ended${took ? ` after ${took}` : ''}: ${words}.${confidence ? ` ${confidence}` : ''}`
  }
}

function driverExited(record: Fields): NarrationLine {
  const exit = whole(record.exit_code)
  const exitWords = exit === null ? '' : ` (exit code ${exit})`
  switch (record.reason) {
    case 'finished':
      return { kind: 'done', text: `The driver finished${exitWords}.` }
    case 'paused':
      return { kind: 'paused', text: `The driver stopped because the loop paused${exitWords}.` }
    case 'reexec':
      return { kind: 'information', text: 'The driver restarted itself on updated code.' }
    case 'error': {
      const kind = code(record.error_class)
      return { kind: 'failed', text: `The driver stopped on an error${kind ? ` (${kind})` : ''}${exitWords}.` }
    }
    case 'signal':
      return { kind: 'failed', text: `The driver was stopped by a signal${exitWords}.` }
    default:
      return { kind: 'information', text: `The driver exited${exitWords}.` }
  }
}

function dispatched(record: Fields): NarrationLine {
  const role = text(record.target_role)
  const who = roleSubject(role)
  const reviewing = role === 'code-reviewer' || role === 'security'
  const round = whole(record.round)
  return {
    kind: 'working',
    text: `${who} is ${reviewing ? 'reviewing' : 'working'}${round === null ? '' : `${reviewing ? '' : ' on'} round ${round}`}.`
  }
}

function outcomeReceived(record: Fields): NarrationLine {
  const who = roleSubject(record.target_role)
  const outcome = record.outcome
  if (typeof outcome === 'object' && outcome !== null && (outcome as Fields).type === 'escalation') {
    const kind = text((outcome as Fields).class)
    return {
      kind: 'blocked',
      text: `${who} raised an escalation${kind ? ` (${kind})` : ''}. A person has to decide.`
    }
  }
  return { kind: 'done', text: `${who} finished its turn.` }
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
        return { kind: 'starting', text: `${roundLabel(fields)} started.` }
      case 'gate_result_read':
        return typeof fields.green === 'boolean'
          ? fields.green
            ? { kind: 'done', text: `${roundLabel(fields)}: the checks passed.` }
            : { kind: 'failed', text: `${roundLabel(fields)}: the checks failed.` }
          : null
      case 'verdicts_read':
        return verdicts(fields)
      case 'round_ended':
        return roundEnded(fields, Array.isArray(earlier) ? earlier : [])
      case 'paused':
        return paused(code(fields.reason_code), text(fields.reason))
      case 'stop_condition_met':
        return stopped(fields.condition)
      case 'driver_exited':
        return driverExited(fields)
      default:
        return null
    }
  } catch {
    return null
  }
}
