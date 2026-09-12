/**
 * The dev-review-loop's policy half (dev-review-loop-v1 task 4, `#414`) —
 * `assessRound`, the loop spec's state machine (Linear "Tech spec —
 * Developer Review Loop", rev 4, §5, §10.4, §13, §16) reduced to one pure
 * function. No `fs`, no `fetch`, no `process.env`, no subprocess, no vendor
 * name, no prompt.
 *
 * A round is up to two calls: a `gate` observation (the mechanical check for
 * the round's new head, carrying the developer's confidence from round 2
 * on), then, once the gate passes and confidence clears, a `verdicts`
 * observation. `#414` O2/O3 (Principal ruling 2026-09-04, Issue amendment
 * 2026-09-06):
 *
 * - Round 1 never asks for confidence.
 * - From round 2 on, a `gate` observation's confidence gates whether
 *   reviewers are dispatched at all this round: absent asks again once, then
 *   pauses; below 50 sends the developer back for one extra turn (spent
 *   once, ever) without ever dispatching reviewers, then pauses on a second
 *   below-50; 50 or over dispatches reviewers.
 * - A `verdicts` observation with any `NOT MET` objective is
 *   `changes_requested` regardless of findings.
 * - The four exits are decided here and nowhere else: an id previously
 *   `resolved` reported again (`stop_condition_met` `condition: 'reappearance'`),
 *   two consecutive rounds resolving no id (`condition: 'no_progress'`), a
 *   confidence collapse per the rule above (`condition: 'confidence'`), and
 *   rounds over 3 (`condition: 'max_rounds'`) — the widened, additive values
 *   Issue #414's 2026-09-06 amendment adds to `stop_condition_met.condition`
 *   so a reader tells a confidence collapse and a finding reappearance apart
 *   from each other and from a generic stall, rather than collapsing all
 *   three onto `no_progress` (superseding this task's own brief §2, which
 *   predates that amendment).
 *
 * Reuse, not a second counter: the id-state map for each round is built by
 * calling `groupRounds` (`../review-status`) with synthetic same-key
 * `VerdictComment`s — the exact "first non-null state wins" merge this
 * module needs for combining a round's reviewer and security findings, with
 * no forked copy of that rule. The reappearance/no-progress comparisons
 * themselves are new: `groupRounds` merges one round's ids, it does not
 * compare across rounds, and `review-status.ts`'s own reappearance/
 * zero-deaths triggers serve a different consumer under different exact
 * cardinality (single-round zero-deaths there vs. two-consecutive-rounds
 * here) — this module owns the exit predicates (O2: "decided there and
 * nowhere else"), built on the reused map.
 */

import { groupRounds, type Round, type VerdictComment } from '../review-status'
import {
  SEVERITY_COLUMNS,
  type Confidence,
  type Decision,
  type DevReviewLoopEventInput,
  type LoopState,
  type Observations,
  type PendingRound,
  type RoundOutcome,
  type RoundRecord,
  type RoundStats,
  type VerdictObservation
} from './types'

const MAX_ROUNDS = 3

function loopEventEnvelope(state: LoopState): {
  kind: 'dev_review_loop'
  payload: Record<string, never>
  loop_id: string
} {
  return { kind: 'dev_review_loop', payload: {}, loop_id: state.config.loopId }
}

function loopStartedEvent(state: LoopState): DevReviewLoopEventInput {
  return {
    ...loopEventEnvelope(state),
    event: 'loop_started',
    task: state.config.task,
    policy: {
      max_rounds: MAX_ROUNDS,
      reviewers: state.config.reviewers as never,
      models: state.config.models as never
    }
  }
}

function roundStartedEvent(state: LoopState, round: number, baseHead: string): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'round_started', round, base_head: baseHead }
}

function gateResultReadEvent(state: LoopState, round: number, head: string, green: boolean): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'gate_result_read', round, head, green }
}

function verdictsReadEvent(state: LoopState, round: number, verdicts: VerdictObservation[]): DevReviewLoopEventInput {
  const allApprove = verdicts.every((v) => v.verdict === 'APPROVE' || v.verdict === 'PASS')
  const head = pendingHead(state, round)
  const blockers = verdicts.filter((v) => v.verdict === 'REQUEST CHANGES' || v.verdict === 'FAIL').length
  return { ...loopEventEnvelope(state), event: 'verdicts_read', round, head, all_approve: allApprove, blockers }
}

type FindingsCompared = { round: number; open: string[]; resolved: string[]; new: string[]; recurring: string[] }

function findingsComparedEvent(state: LoopState, fc: FindingsCompared): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'findings_compared', ...fc }
}

function stopConditionMetEvent(
  state: LoopState,
  round: number,
  condition: 'green' | 'max_rounds' | 'no_progress' | 'escalated' | 'confidence' | 'reappearance'
): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'stop_condition_met', round, condition }
}

function pausedEvent(
  state: LoopState,
  round: number,
  reason: 'escalation' | 'principal_item'
): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'paused', round, reason }
}

function roundEndedEvent(
  state: LoopState,
  round: number,
  stats: RoundStats,
  outcome: 'green' | 'changes_requested' | 'escalated'
): DevReviewLoopEventInput {
  return {
    ...loopEventEnvelope(state),
    event: 'round_ended',
    round,
    base_head: stats.baseHead,
    head: stats.head,
    files_changed: stats.filesChanged,
    insertions: stats.insertions,
    deletions: stats.deletions,
    wall_ms: stats.wallMs,
    outcome
  }
}

function journalFinalizedEvent(
  state: LoopState,
  finalHead: string,
  result: 'merged_ready' | 'stopped'
): DevReviewLoopEventInput {
  return {
    ...loopEventEnvelope(state),
    event: 'journal_finalized',
    rounds: state.rounds.length,
    total_wall_ms: state.totalWallMs,
    time_to_green_ms: result === 'merged_ready' ? state.totalWallMs : null,
    files_changed_total: state.totalFilesChanged,
    final_head: finalHead,
    result
  }
}

function pendingHead(state: LoopState, round: number): string {
  if (state.pending && state.pending.round === round) return state.pending.stats.head
  return ''
}

function buildRoundRecord(
  round: number,
  verdicts: VerdictObservation[],
  confidence: Confidence | null,
  outcome: RoundOutcome
): RoundRecord {
  const countsBySeverity: Record<string, number> = {}
  for (const v of verdicts) {
    for (const f of v.findings) {
      const key = f.severity.toLowerCase()
      if (!(SEVERITY_COLUMNS as readonly string[]).includes(key)) continue
      countsBySeverity[key] = (countsBySeverity[key] ?? 0) + 1
    }
  }
  return { round, countsBySeverity, confidence, outcome }
}

/** Folds one round's diff stats into the running totals `journal_finalized` reports — never recomputed from `rounds`. */
function withRoundStats(state: LoopState, stats: RoundStats): Pick<LoopState, 'totalWallMs' | 'totalFilesChanged'> {
  return {
    totalWallMs: state.totalWallMs + stats.wallMs,
    totalFilesChanged: state.totalFilesChanged + stats.filesChanged
  }
}

/** Merges every verdict's findings into one round's id → state map, reusing `groupRounds`'s exact merge rule. */
function mergeFindings(verdicts: VerdictObservation[]): Map<string, string | null> {
  const comments: VerdictComment[] = verdicts.map((v) => ({
    judgedHead: 'this-round',
    objectivesVersion: null,
    ids: new Map(v.findings.map((f) => [f.id, f.state] as const))
  }))
  const rounds: Round[] = groupRounds(comments)
  return rounds[0]?.ids ?? new Map()
}

function computeFindingsCompared(
  round: number,
  priorIds: Map<string, string | null>,
  currentIds: Map<string, string | null>
): FindingsCompared {
  const open: string[] = []
  const resolved: string[] = []
  const newIds: string[] = []
  const recurring: string[] = []
  for (const [id, state] of currentIds) {
    if (state === 'resolved') resolved.push(id)
    else open.push(id)
    if (!priorIds.has(id)) newIds.push(id)
    else if (priorIds.get(id) === 'resolved' && state === 'reproduced') recurring.push(id)
  }
  return { round, open, resolved, new: newIds, recurring }
}

function mergedIds(
  priorIds: Map<string, string | null>,
  currentIds: Map<string, string | null>
): Map<string, string | null> {
  const merged = new Map(priorIds)
  for (const [id, state] of currentIds) merged.set(id, state)
  return merged
}

function assessGate(
  state: LoopState,
  obs: { round: number; green: boolean; confidence?: Confidence; stats: RoundStats }
): { decision: Decision; state: LoopState; events: DevReviewLoopEventInput[] } {
  const events: DevReviewLoopEventInput[] = []
  const isNewRound = state.pending === null || state.pending.round !== obs.round
  if (isNewRound) {
    if (state.rounds.length === 0 && state.pending === null) events.push(loopStartedEvent(state))
    events.push(roundStartedEvent(state, obs.round, obs.stats.baseHead))
    events.push(gateResultReadEvent(state, obs.round, obs.stats.head, obs.green))
  }

  if (!obs.green) {
    events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
    const record = buildRoundRecord(obs.round, [], null, 'changes_requested')
    const newState: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      ...withRoundStats(state, obs.stats)
    }
    return { decision: { type: 'dispatch_developer' }, state: newState, events }
  }

  if (obs.round === 1) {
    const pending: PendingRound = {
      round: obs.round,
      stats: obs.stats,
      confidenceAskCount: 0,
      confidence: obs.confidence ?? null,
      priorIds: state.lastIds
    }
    return { decision: { type: 'dispatch_reviewers' }, state: { ...state, pending }, events }
  }

  // Round ≥ 2: the confidence gate.
  const priorAskCount = isNewRound ? 0 : (state.pending?.confidenceAskCount ?? 0)
  const confidence = obs.confidence ?? 'absent'

  if (confidence === 'absent') {
    if (priorAskCount >= 1) {
      events.push(stopConditionMetEvent(state, obs.round, 'confidence'))
      events.push(pausedEvent(state, obs.round, 'principal_item'))
      events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
      const record = buildRoundRecord(obs.round, [], null, 'stopped')
      const preFinalize: LoopState = {
        ...state,
        rounds: [...state.rounds, record],
        pending: null,
        ...withRoundStats(state, obs.stats)
      }
      events.push(journalFinalizedEvent(preFinalize, obs.stats.head, 'stopped'))
      return { decision: { type: 'pause', reason: 'confidence' }, state: preFinalize, events }
    }
    const pending: PendingRound = {
      round: obs.round,
      stats: obs.stats,
      confidenceAskCount: priorAskCount + 1,
      confidence: null,
      priorIds: state.lastIds
    }
    return { decision: { type: 'ask_confidence' }, state: { ...state, pending }, events }
  }

  if (confidence.value < 50) {
    if (state.extraTurnUsed) {
      events.push(stopConditionMetEvent(state, obs.round, 'confidence'))
      events.push(pausedEvent(state, obs.round, 'principal_item'))
      events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
      const record = buildRoundRecord(obs.round, [], confidence, 'stopped')
      const preFinalize: LoopState = {
        ...state,
        rounds: [...state.rounds, record],
        pending: null,
        ...withRoundStats(state, obs.stats)
      }
      events.push(journalFinalizedEvent(preFinalize, obs.stats.head, 'stopped'))
      return { decision: { type: 'pause', reason: 'confidence' }, state: preFinalize, events }
    }
    events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
    const record = buildRoundRecord(obs.round, [], confidence, 'changes_requested')
    const newState: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      extraTurnUsed: true,
      ...withRoundStats(state, obs.stats)
    }
    return { decision: { type: 'dispatch_developer', reason: 'confidence' }, state: newState, events }
  }

  const pending: PendingRound = {
    round: obs.round,
    stats: obs.stats,
    confidenceAskCount: priorAskCount,
    confidence,
    priorIds: state.lastIds
  }
  return { decision: { type: 'dispatch_reviewers' }, state: { ...state, pending }, events }
}

function assessVerdicts(
  state: LoopState,
  obs: { round: number; verdicts: VerdictObservation[] }
): { decision: Decision; state: LoopState; events: DevReviewLoopEventInput[] } {
  const pending = state.pending
  if (pending === null || pending.round !== obs.round) {
    throw new Error(`assessRound: verdicts observation for round ${obs.round} with no matching pending gate result`)
  }
  const events: DevReviewLoopEventInput[] = [verdictsReadEvent(state, obs.round, obs.verdicts)]

  const currentIds = mergeFindings(obs.verdicts)
  const fc = computeFindingsCompared(obs.round, pending.priorIds, currentIds)
  events.push(findingsComparedEvent(state, fc))

  const carriedIds = mergedIds(pending.priorIds, currentIds)
  const confidence = pending.confidence

  const hasEscalate = obs.verdicts.some((v) => v.verdict === 'ESCALATE')
  if (hasEscalate) {
    events.push(stopConditionMetEvent(state, obs.round, 'escalated'))
    events.push(pausedEvent(state, obs.round, 'escalation'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'escalated'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'escalated')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'stopped'))
    return { decision: { type: 'pause', reason: 'escalation' }, state: preFinalize, events }
  }

  const allObjectivesMet = obs.verdicts.every((v) => v.objectives.every((o) => o.met))
  const allApprove = obs.verdicts.every((v) => v.verdict === 'APPROVE' || v.verdict === 'PASS')
  const clean = allApprove && allObjectivesMet

  if (clean) {
    events.push(stopConditionMetEvent(state, obs.round, 'green'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'green'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'green')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'merged_ready'))
    return { decision: { type: 'publish' }, state: preFinalize, events }
  }

  if (fc.recurring.length > 0) {
    events.push(stopConditionMetEvent(state, obs.round, 'reappearance'))
    events.push(pausedEvent(state, obs.round, 'principal_item'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'changes_requested'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'stopped')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'stopped'))
    return { decision: { type: 'pause', reason: 'reappearance' }, state: preFinalize, events }
  }

  const resolvedEmptyThisRound = fc.resolved.length === 0
  if (resolvedEmptyThisRound && state.previousResolvedEmpty === true) {
    events.push(stopConditionMetEvent(state, obs.round, 'no_progress'))
    events.push(pausedEvent(state, obs.round, 'principal_item'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'changes_requested'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'stopped')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'stopped'))
    return { decision: { type: 'pause', reason: 'no_progress' }, state: preFinalize, events }
  }

  if (obs.round > MAX_ROUNDS) {
    events.push(stopConditionMetEvent(state, obs.round, 'max_rounds'))
    events.push(pausedEvent(state, obs.round, 'principal_item'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'changes_requested'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'stopped')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'stopped'))
    return { decision: { type: 'pause', reason: 'max_rounds' }, state: preFinalize, events }
  }

  events.push(roundEndedEvent(state, obs.round, pending.stats, 'changes_requested'))
  const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'changes_requested')
  const newState: LoopState = {
    ...state,
    rounds: [...state.rounds, record],
    pending: null,
    lastIds: carriedIds,
    previousResolvedEmpty: resolvedEmptyThisRound,
    ...withRoundStats(state, pending.stats)
  }
  return { decision: { type: 'dispatch_developer' }, state: newState, events }
}

/**
 * `assessRound(state, observations) → { decision, state, events }` — pure,
 * no I/O. `events` is the `DevReviewLoopEventInput[]` the caller passes,
 * unchanged, to the injected `log()` (O5); `assessRound` itself never calls
 * it.
 */
export function assessRound(
  state: LoopState,
  observations: Observations
): { decision: Decision; state: LoopState; events: DevReviewLoopEventInput[] } {
  if (observations.kind === 'gate') return assessGate(state, observations)
  return assessVerdicts(state, observations)
}
