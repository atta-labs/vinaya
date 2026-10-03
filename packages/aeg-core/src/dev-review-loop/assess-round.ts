/**
 * The dev-review-loop's policy half —
 * `assessRound`, the loop spec's state machine (Linear "Tech spec —
 * Developer Review Loop", rev 4, §5, §10.4, §13, §16) reduced to one pure
 * function. No `fs`, no `fetch`, no `process.env`, no subprocess, no vendor
 * name, no prompt.
 *
 * A round is up to two calls: a `gate` observation (the mechanical check for
 * the round's new head, carrying the developer's confidence from round 2
 * on), then, once the gate passes and confidence clears, a `verdicts`
 * observation. A Principal ruling (2026-09-04, amended 2026-09-06):
 *
 * - Round 1 never asks for confidence.
 * - From round 2 on, a `gate` observation's confidence gates whether
 *   reviewers are dispatched at all this round: absent asks again once, then
 *   pauses; below 50 sends the developer back for one extra turn (spent
 *   once, ever) without ever dispatching reviewers, then pauses on a second
 *   below-50; 50 or over dispatches reviewers.
 * - A `verdicts` observation with any `NOT MET` objective is
 *   `changes_requested` regardless of findings.
 * - The three exits are decided here and nowhere else: an id previously
 *   `resolved` reported again (`stop_condition_met` `condition: 'reappearance'`),
 *   a confidence collapse per the rule above (`condition: 'confidence'`), and
 *   a round that reaches the cap without going green (`condition: 'max_rounds'`;
 *   the default cap is 3, so rounds 1–3 run and the loop pauses after round
 *   3's review, and a green round at the cap still publishes) — distinct
 *   `condition` values a 2026-09-06 amendment adds to `stop_condition_met.condition` so a reader
 *   tells a confidence collapse and a finding reappearance apart from each
 *   other and from the round cap. A fourth exit once lived here too — two
 *   consecutive rounds resolving no id (`condition: 'no_progress'`) — but it
 *   read a resolved-id signal no reviewer observation ever fills (every
 *   `state` comes back `null`), so it paused loops that had made real
 *   progress; it is removed. The `no_progress` condition and pause reason
 *   survive only for the driver's own attach-redelivery pause and for
 *   already-written journals, never as an assessment exit here.
 * - Two further exits, each with its own `condition` value and pause reason,
 *   stop a loop that is repeating itself rather than converging: the same
 *   BLOCKING finding — same reviewer role, same finding id — still open in
 *   two consecutive reviewed rounds (`condition: 'repeat_finding'`), and two
 *   consecutive attempts ending on the same mechanical failure
 *   (`condition: 'repeat_failure'`). Neither revives `no_progress`: a round
 *   that resolves nothing but raises only new findings still continues, and
 *   a round whose repeated finding is non-blocking continues too. Both name
 *   what repeated in the pause's own `detail`.
 * - One further exit bounds the task by TIME rather than by rounds or repeats:
 *   the task's ACTIVE working time — the sum of the phases a driver spent
 *   developing, reviewing and awaiting confidence, never the hours it sat
 *   paused, published or driverless — passing `ReviewPolicy.maxTaskMinutes`
 *   (`condition: 'time_budget'`). It is the one exit a loop cannot outrun by
 *   never advancing — the round cap bounds review rounds, and a loop stuck
 *   pushing, rebasing and retrying advances no round at all — and the one whose
 *   measurement this module cannot make itself: the caller reads the clock and
 *   hands it in (`TaskClock.elapsedMs`, already the active sum), since the
 *   per-phase times that survive a driver restart live in the durable control
 *   records, which nothing in this package may read.
 *
 * Reuse, not a second counter: the id-state map for each round is built by
 * calling `groupRounds` (`../review-status`) with synthetic same-key
 * `VerdictComment`s — the exact "first non-null state wins" merge this
 * module needs for combining a round's reviewer and security findings, with
 * no forked copy of that rule. The reappearance comparison itself is new:
 * `groupRounds` merges one round's ids, it does not compare across rounds,
 * and `review-status.ts`'s own reappearance/zero-deaths triggers serve a
 * different consumer — this module owns the exit predicates (O2: "decided
 * there and nowhere else"), built on the reused map.
 */

import { groupRounds, type Round, type VerdictComment } from '../review-status'
import { isActiveBudgetPhase, taskPhaseLabel } from '../task-phase-history'
import {
  SEVERITY_COLUMNS,
  type Confidence,
  type Decision,
  type DeferredFindingRow,
  type DevReviewLoopEventInput,
  type LoopState,
  type NotReviewedReason,
  type Observations,
  type PendingRound,
  type RoundOutcome,
  type RoundRecord,
  type RoundStats,
  type TaskClock,
  type VerdictObservation
} from './types'

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
      // Repository policy, resolved once by the driver into
      // `LoopConfig.maxRounds` — never a hardcoded constant here.
      max_rounds: state.config.maxRounds,
      reviewers: state.config.reviewers as never,
      models: state.config.models as never
    }
  }
}

function roundStartedEvent(state: LoopState, round: number, baseHead: string): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'round_started', round, base_head: baseHead }
}

/**
 * `confidence` is exactly what THIS gate call's own confidence read
 * returned — `undefined` for round 1 or a red gate (neither ever reads the
 * file), `'absent'` for a missing or malformed statement, or the parsed
 * value/reason otherwise. Called once per `assessGate` invocation, not only
 * a round's first: a re-ask that recovers a real statement after an earlier
 * absent read gets its own event, rather than leaving the round's log stuck
 * on the earlier read's `confidence_unavailable: true`. `state.extraTurnUsed`
 * is read here, before this call's own branch in `assessGate` can set it —
 * so it reports whether the confidence rule's one extra turn was already
 * spent BEFORE this read, never whether this call's own outcome later spends
 * it.
 */
function gateResultReadEvent(
  state: LoopState,
  round: number,
  head: string,
  green: boolean,
  confidence: Confidence | undefined
): DevReviewLoopEventInput {
  const confidenceFields =
    confidence === undefined
      ? {}
      : confidence === 'absent'
        ? { confidence_unavailable: true as const, extra_turn_spent: state.extraTurnUsed }
        : {
            confidence_value: confidence.value,
            ...(confidence.reason !== undefined ? { confidence_reason: confidence.reason } : {}),
            extra_turn_spent: state.extraTurnUsed
          }
  return { ...loopEventEnvelope(state), event: 'gate_result_read', round, head, green, ...confidenceFields }
}

/**
 * `FindingObservation` → `ReviewFindingSchema`
 * field-for-field, snake_cased at this boundary the same way every other
 * envelope field already is. `state: null` reads back as omitted — the
 * schema's own `state` is an optional string, never nullable, matching
 * `dispatchShared`'s sibling fields' own "absent, not null" convention.
 */
function toReviewFinding(f: VerdictObservation['findings'][number]): {
  id: string
  severity: string
  state?: string
  severity_scale?: string
  policy_treatment?: 'blocking' | 'non_blocking' | 'unavailable'
  confidence?: number
  confidence_scale?: string
  confidence_source?: string
} {
  return {
    id: f.id,
    severity: f.severity,
    ...(f.state !== null && f.state !== undefined ? { state: f.state } : {}),
    ...(f.severityScale !== undefined ? { severity_scale: f.severityScale } : {}),
    ...(f.policyTreatment !== undefined ? { policy_treatment: f.policyTreatment } : {}),
    ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
    ...(f.confidenceScale !== undefined ? { confidence_scale: f.confidenceScale } : {}),
    ...(f.confidenceSource !== undefined ? { confidence_source: f.confidenceSource } : {})
  }
}

/** The doctrine role a verdict's own role names — `VerdictObservation.role` says `'reviewer'` where the log's role vocabulary says `'code-reviewer'`. */
function verdictLogRole(role: VerdictObservation['role']): string {
  return role === 'reviewer' ? 'code-reviewer' : role
}

/**
 * One entry per reviewer role the loop held or expected a verdict from, taken
 * from the verdicts themselves (never from the findings): a role that
 * approved with no findings appears, and a configured role with no verdict
 * reads `not_reviewed`. A blocking verdict contributes one blocker, so the
 * entries add up to the event's own `blockers`; an `ESCALATE` verdict is not
 * an approval and not a counted blocker, so it reads `changes_requested`
 * with none.
 */
function reviewerEntries(
  state: LoopState,
  verdicts: VerdictObservation[]
): NonNullable<Extract<DevReviewLoopEventInput, { event: 'verdicts_read' }>['reviewers']> {
  const held = new Map(verdicts.map((v) => [verdictLogRole(v.role), v]))
  const roles = [...new Set([...state.config.reviewers, ...held.keys()])]
  return roles.map((role) => {
    const v = held.get(role)
    const entry =
      v === undefined
        ? { outcome: 'not_reviewed' as const, blockers: 0 }
        : v.verdict === 'APPROVE' || v.verdict === 'PASS'
          ? { outcome: 'approve' as const, blockers: 0 }
          : { outcome: 'changes_requested' as const, blockers: v.verdict === 'ESCALATE' ? 0 : 1 }
    return { role: role as never, ...entry }
  })
}

function verdictsReadEvent(state: LoopState, round: number, verdicts: VerdictObservation[]): DevReviewLoopEventInput {
  const allApprove = verdicts.every((v) => v.verdict === 'APPROVE' || v.verdict === 'PASS')
  const head = pendingHead(state, round)
  const blockers = verdicts.filter((v) => v.verdict === 'REQUEST CHANGES' || v.verdict === 'FAIL').length
  const findings = verdicts.flatMap((v) => v.findings.map(toReviewFinding))
  return {
    ...loopEventEnvelope(state),
    event: 'verdicts_read',
    round,
    head,
    all_approve: allApprove,
    blockers,
    findings,
    reviewers: reviewerEntries(state, verdicts)
  }
}

type FindingsCompared = { round: number; open: string[]; resolved: string[]; new: string[]; recurring: string[] }

function findingsComparedEvent(state: LoopState, fc: FindingsCompared): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'findings_compared', ...fc }
}

function stopConditionMetEvent(
  state: LoopState,
  round: number,
  condition:
    | 'green'
    | 'max_rounds'
    | 'no_progress'
    | 'escalated'
    | 'confidence'
    | 'reappearance'
    | 'repeat_finding'
    | 'repeat_failure'
    | 'time_budget'
): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'stop_condition_met', round, condition }
}

function pausedEvent(
  state: LoopState,
  round: number,
  reason: 'escalation' | 'principal_item',
  reasonCode: string
): DevReviewLoopEventInput {
  return { ...loopEventEnvelope(state), event: 'paused', round, reason, reason_code: reasonCode }
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
  // Every column this round MEASURED, seeded at zero before a single finding
  // is counted — so a round the loop assessed and found nothing in is a
  // recorded zero, not an absent count. A reader needs the two told
  // apart: a round rebuilt from the pull
  // request's markers after a restart has no counts at all, and must report
  // nothing rather than a zero a reader would take for a clean round.
  const countsBySeverity: Record<string, number> = {}
  for (const key of SEVERITY_COLUMNS) countsBySeverity[key] = 0
  // O4: the findings this round set aside rather than let them block, in the
  // order the verdicts reported them, each with its original severity and
  // location — never its reported severity mutated (that is the whole point
  // of a deferral: the finding is real, this round just cannot act on it).
  const deferred: DeferredFindingRow[] = []
  for (const v of verdicts) {
    for (const f of v.findings) {
      const key = f.severity.toLowerCase()
      if ((SEVERITY_COLUMNS as readonly string[]).includes(key)) {
        countsBySeverity[key] = (countsBySeverity[key] ?? 0) + 1
      }
      if (f.deferred !== undefined) {
        deferred.push({ severity: f.severity, location: f.location ?? '', reason: f.deferred })
      }
    }
  }
  return { round, countsBySeverity, confidence, outcome, ...(deferred.length > 0 ? { deferred } : {}) }
}

/**
 * A round that ended before any reviewer ran — its gate was not green, or a
 * below-threshold confidence sent the developer back — has no findings from any
 * source. Unlike `buildRoundRecord`, it records NO counts (an empty
 * `countsBySeverity`, the shape a marker-reconstructed round also carries), so
 * no severity column reads as a `0` a reader would take for a clean review. `outcome` is left
 * exactly as this round would otherwise carry — the `round_ended` log event is
 * unchanged — and `notReviewed` names why no reviewer saw it for the table's
 * outcome cell.
 */
function buildUnreviewedRecord(
  round: number,
  confidence: Confidence | null,
  outcome: RoundOutcome,
  reason: NotReviewedReason
): RoundRecord {
  return { round, countsBySeverity: {}, confidence, outcome, notReviewed: reason }
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

/**
 * A round's BLOCKING, still-open findings as `<role>:<id>` keys, sorted and
 * de-duplicated — the identity the `'repeat_finding'` stop compares across
 * rounds. Two deliberate narrowings: a finding counts as the same one only by
 * reviewer role AND id (the same id from the two roles is two findings, since
 * each role numbers its own report), and only a finding the effective policy
 * treated as `blocking` counts at all — a `non_blocking` finding never sent
 * the developer back, so its repeat is not a loop failing to converge. A
 * finding whose treatment the observation does not state is not counted
 * either: the stop pauses a task, and an unstated treatment is not evidence.
 * A deferred finding is excluded by the same test, without naming deferral at
 * all: `policyTreatment` reads `non_blocking` whenever `deferred` is set
 * (`types.ts`), and a finding the round never asked the developer to act on
 * cannot be one the developer failed to close.
 */
function blockingOpenKeys(verdicts: VerdictObservation[]): string[] {
  const keys = new Set<string>()
  for (const v of verdicts) {
    for (const f of v.findings) {
      if (f.policyTreatment !== 'blocking') continue
      if (f.state === 'resolved') continue
      keys.add(`${v.role}:${f.id}`)
    }
  }
  return [...keys].sort()
}

/**
 * The fixed volatile-token list the `'repeat_failure'` stop matches on —
 * everything that naturally differs between two runs of the SAME failure and
 * nothing that distinguishes two DIFFERENT ones. Timestamps, temporary
 * directories, process ids, durations and commit shas become a fixed
 * placeholder; the message's own words — which check failed, which premise
 * pin is absent — survive untouched, so `absent: maxRounds` and
 * `absent: reviewers` never collapse into one signature.
 */
const VOLATILE_TOKENS: readonly { pattern: RegExp; replacement: string }[] = [
  // ISO-8601 timestamps, with or without fractional seconds and zone.
  { pattern: /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/g, replacement: '<ts>' },
  // A bare clock time — a log line's own prefix.
  { pattern: /\b\d{1,2}:\d{2}:\d{2}\b/g, replacement: '<ts>' },
  // Temporary directories — the per-run scratch paths a retry never reuses.
  { pattern: /(?:\/private)?\/(?:tmp|var\/folders)\/[^\s,;)'"]*/g, replacement: '<tmp>' },
  // Process ids, however the producer spells them.
  { pattern: /\b(?:pid|process)[ =:]+\d+/g, replacement: 'pid <pid>' },
  // Durations: 1200ms, 1.2s, 90 seconds, 3m.
  { pattern: /\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|milliseconds?|seconds?|minutes?|hours?)\b/g, replacement: '<dur>' },
  // Commit shas and other long hex runs.
  { pattern: /\b[0-9a-f]{7,40}\b/g, replacement: '<sha>' }
]

/**
 * What the `'repeat_failure'` rule makes of one reported failure: the
 * `{signature, message}` pair to remember (`null` for a failure the driver
 * could not name — nothing left after normalisation), and whether it matches
 * the previous attempt's. Shared by both observation kinds that can carry a
 * mechanical failure, so a repeat means the same thing whether or not the
 * attempt produced a head.
 */
function matchFailure(
  state: LoopState,
  reported: string | undefined
): { failure: { signature: string; message: string } | null; repeat: boolean } {
  const message = reported?.trim() ?? ''
  const signature = message === '' ? '' : normalizeFailureSignature(message)
  if (signature === '') return { failure: null, repeat: false }
  return { failure: { signature, message }, repeat: state.lastFailure?.signature === signature }
}

/**
 * One mechanical failure's matching signature (O3) — lower-cased, volatile
 * tokens replaced per the fixed list above, whitespace collapsed. Pure and
 * total: any string in, a signature out; the empty string for a message with
 * nothing left, which the caller treats as no signature at all.
 */
export function normalizeFailureSignature(message: string): string {
  let out = message.toLowerCase()
  for (const { pattern, replacement } of VOLATILE_TOKENS) out = out.replace(pattern, replacement)
  return out.replace(/\s+/g, ' ').trim()
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
  obs: { round: number; green: boolean; confidence?: Confidence; stats: RoundStats; failure?: string }
): { decision: Decision; state: LoopState; events: DevReviewLoopEventInput[] } {
  const events: DevReviewLoopEventInput[] = []
  const isNewRound = state.pending === null || state.pending.round !== obs.round
  if (isNewRound) {
    if (state.rounds.length === 0 && state.pending === null) events.push(loopStartedEvent(state))
    events.push(roundStartedEvent(state, obs.round, obs.stats.baseHead))
  }
  // A confidence re-ask keeps `pending` alive on the SAME round (only its
  // `confidenceAskCount` advances), so `isNewRound` alone would suppress the
  // second, real read's own event and leave the round's log stuck on the
  // first read's `confidence_unavailable: true` — logged even after the loop
  // went on to read and act on a real value. Emitting on every call, not
  // only a new round, means the re-ask's real read gets its own event too.
  events.push(gateResultReadEvent(state, obs.round, obs.stats.head, obs.green, obs.confidence))

  if (!obs.green) {
    // The mechanical failure that ended this attempt, matched against the
    // previous attempt's by normalised signature — never by raw equality,
    // which two runs of the same failure never satisfy (different
    // timestamps, scratch paths, process ids, durations). A failure the
    // driver could not name at all (`undefined`, or nothing left after
    // normalisation) is no signature: it breaks the chain rather than
    // matching one unknown to another.
    const { failure, repeat } = matchFailure(state, obs.failure)
    if (repeat && failure !== null) {
      events.push(stopConditionMetEvent(state, obs.round, 'repeat_failure'))
      events.push(pausedEvent(state, obs.round, 'principal_item', 'repeat_failure'))
      events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
      const record = buildUnreviewedRecord(obs.round, null, 'stopped', 'checks_red')
      const preFinalize: LoopState = {
        ...state,
        rounds: [...state.rounds, record],
        pending: null,
        lastFailure: failure,
        ...withRoundStats(state, obs.stats)
      }
      events.push(journalFinalizedEvent(preFinalize, obs.stats.head, 'stopped'))
      // The pause carries the failure as reported, not the signature: the
      // normalised form exists only to match two attempts, never to be read.
      return {
        decision: { type: 'pause', reason: 'repeat_failure', detail: failure.message },
        state: preFinalize,
        events
      }
    }
    events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
    const record = buildUnreviewedRecord(obs.round, null, 'changes_requested', 'checks_red')
    const newState: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastFailure: failure,
      ...withRoundStats(state, obs.stats)
    }
    return { decision: { type: 'dispatch_developer' }, state: newState, events }
  }

  // Past the red branch the gate is green: whatever mechanical failure the
  // previous attempt hit is over, so the repeat chain starts again from
  // nothing. Every state this function returns below carries that.
  const clearedFailure = { lastFailure: null } as const

  if (obs.round === 1) {
    const pending: PendingRound = {
      round: obs.round,
      stats: obs.stats,
      confidenceAskCount: 0,
      confidence: obs.confidence ?? null,
      priorIds: state.lastIds
    }
    return { decision: { type: 'dispatch_reviewers' }, state: { ...state, ...clearedFailure, pending }, events }
  }

  // Round ≥ 2: the confidence gate.
  const priorAskCount = isNewRound ? 0 : (state.pending?.confidenceAskCount ?? 0)
  const confidence = obs.confidence ?? 'absent'

  if (confidence === 'absent') {
    if (priorAskCount >= 1) {
      events.push(stopConditionMetEvent(state, obs.round, 'confidence'))
      events.push(pausedEvent(state, obs.round, 'principal_item', 'confidence'))
      events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
      const record = buildRoundRecord(obs.round, [], null, 'stopped')
      const preFinalize: LoopState = {
        ...state,
        ...clearedFailure,
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
    return { decision: { type: 'ask_confidence' }, state: { ...state, ...clearedFailure, pending }, events }
  }

  if (confidence.value < 50) {
    if (state.extraTurnUsed) {
      events.push(stopConditionMetEvent(state, obs.round, 'confidence'))
      events.push(pausedEvent(state, obs.round, 'principal_item', 'confidence'))
      events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
      const record = buildRoundRecord(obs.round, [], confidence, 'stopped')
      const preFinalize: LoopState = {
        ...state,
        ...clearedFailure,
        rounds: [...state.rounds, record],
        pending: null,
        ...withRoundStats(state, obs.stats)
      }
      events.push(journalFinalizedEvent(preFinalize, obs.stats.head, 'stopped'))
      return { decision: { type: 'pause', reason: 'confidence' }, state: preFinalize, events }
    }
    events.push(roundEndedEvent(state, obs.round, obs.stats, 'changes_requested'))
    const record = buildUnreviewedRecord(obs.round, confidence, 'changes_requested', 'low_confidence')
    const newState: LoopState = {
      ...state,
      ...clearedFailure,
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
  return { decision: { type: 'dispatch_reviewers' }, state: { ...state, ...clearedFailure, pending }, events }
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
  // This round's blocking-and-open finding keys, compared against the
  // PREVIOUS reviewed round's before any exit below can consume them, and
  // carried into every state this function returns — a round the loop pauses
  // on still records what it saw, exactly as `lastIds` does.
  const currentBlocking = blockingOpenKeys(obs.verdicts)
  const repeatedBlocking = currentBlocking.filter((key) => state.lastBlockingFindings.includes(key))
  const confidence = pending.confidence

  const hasEscalate = obs.verdicts.some((v) => v.verdict === 'ESCALATE')
  if (hasEscalate) {
    events.push(stopConditionMetEvent(state, obs.round, 'escalated'))
    events.push(pausedEvent(state, obs.round, 'escalation', 'escalation'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'escalated'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'escalated')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      lastBlockingFindings: currentBlocking,
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
      lastBlockingFindings: currentBlocking,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'merged_ready'))
    return { decision: { type: 'publish' }, state: preFinalize, events }
  }

  if (fc.recurring.length > 0) {
    events.push(stopConditionMetEvent(state, obs.round, 'reappearance'))
    events.push(pausedEvent(state, obs.round, 'principal_item', 'reappearance'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'changes_requested'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'stopped')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      lastBlockingFindings: currentBlocking,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'stopped'))
    return { decision: { type: 'pause', reason: 'reappearance' }, state: preFinalize, events }
  }

  if (repeatedBlocking.length > 0) {
    events.push(stopConditionMetEvent(state, obs.round, 'repeat_finding'))
    events.push(pausedEvent(state, obs.round, 'principal_item', 'repeat_finding'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'changes_requested'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'stopped')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      lastBlockingFindings: currentBlocking,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'stopped'))
    // The pause names the finding(s), so a Principal reading it never has to
    // diff two rounds' reports to learn what the developer could not close.
    return {
      decision: {
        type: 'pause',
        reason: 'repeat_finding',
        detail: `open after two consecutive rounds: ${repeatedBlocking.join(', ')}`
      },
      state: preFinalize,
      events
    }
  }

  if (obs.round >= state.config.maxRounds) {
    events.push(stopConditionMetEvent(state, obs.round, 'max_rounds'))
    events.push(pausedEvent(state, obs.round, 'principal_item', 'max_rounds'))
    events.push(roundEndedEvent(state, obs.round, pending.stats, 'changes_requested'))
    const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'stopped')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastIds: carriedIds,
      lastBlockingFindings: currentBlocking,
      ...withRoundStats(state, pending.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, pending.stats.head, 'stopped'))
    // The pause names the configured cap, not a bare "max_rounds".
    return {
      decision: { type: 'pause', reason: 'max_rounds', detail: `max rounds: ${state.config.maxRounds}` },
      state: preFinalize,
      events
    }
  }

  events.push(roundEndedEvent(state, obs.round, pending.stats, 'changes_requested'))
  const record = buildRoundRecord(obs.round, obs.verdicts, confidence, 'changes_requested')
  const newState: LoopState = {
    ...state,
    rounds: [...state.rounds, record],
    pending: null,
    lastIds: carriedIds,
    lastBlockingFindings: currentBlocking,
    ...withRoundStats(state, pending.stats)
  }
  return { decision: { type: 'dispatch_developer' }, state: newState, events }
}

/**
 * An attempt that ended on a mechanical failure without producing a head.
 * The SAME `'repeat_failure'` rule the gate path applies, on an observation
 * that has no gate result to carry: a second consecutive attempt whose
 * failure normalises to the previous one's signature pauses, naming the
 * failure exactly as the driver reported it. A first occurrence — or an
 * attempt whose failure differs from the previous one's — records the
 * signature and nothing else: no round record, no events, no diff-stat
 * accounting, since no head was produced and the driver's own first-occurrence
 * bounds still govern what happens next.
 */
function assessMechanicalFailure(
  state: LoopState,
  obs: { round: number; failure: string; stats: RoundStats }
): { decision: Decision; state: LoopState; events: DevReviewLoopEventInput[] } {
  const { failure, repeat } = matchFailure(state, obs.failure)
  if (repeat && failure !== null) {
    const events: DevReviewLoopEventInput[] = [
      stopConditionMetEvent(state, obs.round, 'repeat_failure'),
      pausedEvent(state, obs.round, 'principal_item', 'repeat_failure'),
      roundEndedEvent(state, obs.round, obs.stats, 'changes_requested')
    ]
    const record = buildUnreviewedRecord(obs.round, null, 'stopped', 'mechanical_failure')
    const preFinalize: LoopState = {
      ...state,
      rounds: [...state.rounds, record],
      pending: null,
      lastFailure: failure,
      ...withRoundStats(state, obs.stats)
    }
    events.push(journalFinalizedEvent(preFinalize, obs.stats.head, 'stopped'))
    return {
      decision: { type: 'pause', reason: 'repeat_failure', detail: failure.message },
      state: preFinalize,
      events
    }
  }
  return { decision: { type: 'dispatch_developer' }, state: { ...state, lastFailure: failure }, events: [] }
}

// --- the task's own wall-clock budget --------------------------------------

/** Whole minutes, rounded to the nearest — every figure the time stop names a reader in. */
function minutesOf(ms: number): number {
  return Math.round(ms / 60_000)
}

/**
 * `true` when the task has spent longer than `maxTaskMinutes` in ACTIVE work —
 * `clock.elapsedMs`, which the caller has already summed from the active phases
 * alone (`activeBudgetMs`), so paused, publishing and driverless time can never
 * blow the budget. `0` — and any value below it, which `resolveReviewPolicy`
 * refuses at config load and this predicate still treats as off rather than as
 * a budget already blown — turns the budget off: the loop then bounds rounds
 * only, exactly as it did before this budget existed.
 *
 * The comparison is strictly greater, so a task sitting exactly on its budget
 * has not passed it. The round cap reads the other way: a round that REACHES
 * `state.config.maxRounds` without going green pauses, since the cap is the
 * number of rounds that run.
 */
export function taskBudgetExceeded(maxTaskMinutes: number, clock: TaskClock): boolean {
  if (maxTaskMinutes <= 0) return false
  return clock.elapsedMs > maxTaskMinutes * 60_000
}

/**
 * Where the time went, longest phase first — `developing 190 min, reviewing
 * 22 min`. Phases are named with `taskPhaseLabel`, the SAME vocabulary
 * `task status` renders a live run's phase in, so the pause and the status
 * table call one phase by one name; a phase that vocabulary does not know
 * reads back as the loop's own recorded word rather than as a guess.
 *
 * A phase that accrued under a minute is still listed, at `0 min`: the loop
 * recorded time there, and a reader is better served by a short row than by a
 * phase silently missing. An empty breakdown renders `no phase times
 * recorded` — the honest answer for a run whose earlier phases were recorded
 * by a driver that has since died, never a fabricated single row covering the
 * whole elapsed time.
 */
export function renderPhaseBreakdown(byPhaseMs: Record<string, number>): string {
  const entries = Object.entries(byPhaseMs).filter(([, ms]) => ms >= 0)
  if (entries.length === 0) return 'no phase times recorded'
  return entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([phase, ms]) => `${taskPhaseLabel(phase)} ${minutesOf(ms)} min`)
    .join(', ')
}

/**
 * The `'time_budget'` pause's own `detail` — the budget, the ACTIVE time
 * actually spent, and the breakdown of the active phases that time was summed
 * from, in that order, so a Principal reading it learns whether the budget is
 * too tight or one working phase ran away without opening the run's log.
 *
 * `spent` is `clock.elapsedMs` — the very figure `taskBudgetExceeded` compared
 * against the budget — and the breakdown names ONLY the active phases
 * (`isActiveBudgetPhase`), so the numbers in the breakdown sum to the number
 * reported as spent. Time the task sat `paused` or `publishing` is in
 * `byPhaseMs` (the full record) but is deliberately absent here: it never
 * counted toward the budget, so the pause never names it as time the budget
 * spent.
 */
export function renderTaskBudgetDetail(maxTaskMinutes: number, clock: TaskClock): string {
  const activePhaseMs: Record<string, number> = {}
  for (const [phase, ms] of Object.entries(clock.byPhaseMs)) {
    if (isActiveBudgetPhase(phase)) activePhaseMs[phase] = ms
  }
  return `task time budget: ${maxTaskMinutes} min, spent ${minutesOf(clock.elapsedMs)} min — ${renderPhaseBreakdown(activePhaseMs)}`
}

/**
 * The time stop, built in the same four-event shape every other bounded pause
 * here emits (`stop_condition_met`, `paused`, `round_ended`,
 * `journal_finalized`) so a reader — or a machine parsing the outbox — sees a
 * complete pause record, not a special case.
 *
 * The round it lands on is a round no reviewer saw, and records as one
 * (`notReviewed: 'time_budget'`, no counts): this
 * stop is only ever checked at a round boundary or a mechanical retry, never
 * on a `verdicts` observation, so verdicts already back from reviewers are
 * never thrown away by it. `lastFailure` is left exactly as it stands — the
 * budget running out says nothing about whether the previous attempt's
 * mechanical failure has cleared.
 */
function timeBudgetPause(
  state: LoopState,
  obs: { round: number; stats: RoundStats },
  clock: TaskClock
): { decision: Decision; state: LoopState; events: DevReviewLoopEventInput[] } {
  const events: DevReviewLoopEventInput[] = [
    stopConditionMetEvent(state, obs.round, 'time_budget'),
    pausedEvent(state, obs.round, 'principal_item', 'time_budget'),
    roundEndedEvent(state, obs.round, obs.stats, 'changes_requested')
  ]
  const record = buildUnreviewedRecord(obs.round, null, 'stopped', 'time_budget')
  const preFinalize: LoopState = {
    ...state,
    rounds: [...state.rounds, record],
    pending: null,
    ...withRoundStats(state, obs.stats)
  }
  events.push(journalFinalizedEvent(preFinalize, obs.stats.head, 'stopped'))
  return {
    decision: {
      type: 'pause',
      reason: 'time_budget',
      detail: renderTaskBudgetDetail(state.config.maxTaskMinutes, clock)
    },
    state: preFinalize,
    events
  }
}

/**
 * `assessRound(state, observations, clock?) → { decision, state, events }` —
 * pure, no I/O. `events` is the `DevReviewLoopEventInput[]` the caller passes,
 * unchanged, to the injected `log()`; `assessRound` itself never calls
 * it.
 *
 * `clock` is the task's own wall clock, read by the caller (this module has
 * none). Supplied, it arms the `'time_budget'` stop below; omitted, the
 * assessment is exactly the round-and-repeat-bounded one it was — so a caller
 * that cannot measure the task's first start honestly passes nothing rather
 * than a clock starting at its own process's start, which would mean a loop
 * restarted often enough never approaches its budget.
 *
 * The budget is checked on a `gate` observation and on a `mechanical_failure`
 * observation, and on neither of those does a round's review exist yet: those
 * two kinds are exactly the round boundaries and the mechanical retries, so a
 * phase stuck short of review cannot outrun the budget by more than the one
 * attempt in flight when it ran out. A `verdicts` observation is deliberately
 * NOT checked — reviewers have already done the round's work by then, and
 * discarding their verdicts to save minutes the round has already spent would
 * buy nothing.
 */
export function assessRound(
  state: LoopState,
  observations: Observations,
  clock?: TaskClock
): { decision: Decision; state: LoopState; events: DevReviewLoopEventInput[] } {
  if (observations.kind === 'verdicts') return assessVerdicts(state, observations)
  if (clock !== undefined && taskBudgetExceeded(state.config.maxTaskMinutes, clock)) {
    return timeBudgetPause(state, observations, clock)
  }
  if (observations.kind === 'gate') return assessGate(state, observations)
  return assessMechanicalFailure(state, observations)
}
