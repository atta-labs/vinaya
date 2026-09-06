/**
 * The dev-review-loop's own types (dev-review-loop-v1 task 4, `#414`) — the
 * policy half of the loop spec (Linear "Tech spec — Developer Review Loop",
 * rev 4, §16). Pure — no `fs`, no `fetch`, no `process.env`, no vendor name,
 * no prompt anywhere in this directory.
 */

import type { DevReviewLoopEvent } from '../log'

type Envelope = { meta: unknown; subject: unknown }
/**
 * The same shape `apps/cli/src/lib/log-sink.ts`'s `LogEventInput` derives
 * from `LogEvent` — mirrored here, scoped to `DevReviewLoopEvent` only,
 * because this package can never import from `apps/cli` (the surface runs
 * one way). `assessRound`'s caller (the driver) passes each returned event
 * straight to the injected `log()`, which fills `meta`/`subject` itself.
 */
type StripEnvelope<T> = T extends Envelope ? Omit<T, 'meta' | 'subject'> : never
export type DevReviewLoopEventInput = StripEnvelope<DevReviewLoopEvent>

/** O4's fixed column order — shared by `assess-round.ts` (counting) and `render-summary.ts` (rendering) so the two never drift apart. */
export const SEVERITY_COLUMNS = ['blocker', 'major', 'minor', 'critical', 'high', 'medium', 'low'] as const

/** The built form's finding identity (spec §0 item 1) — no fingerprint hashing. */
export type FindingState = 'open' | 'fix-claimed' | 'reproduced' | 'resolved' | null

export type FindingObservation = {
  id: string
  severity: string
  state: FindingState
}

export type VerdictObservation = {
  role: 'reviewer' | 'security'
  verdict: 'APPROVE' | 'REQUEST CHANGES' | 'PASS' | 'FAIL' | 'ESCALATE'
  objectives: { id: string; met: boolean }[]
  findings: FindingObservation[]
}

/** `spec §6.7`: required, but only ever recorded — never branches except by this task's Principal ruling (§2). */
export type Confidence = { value: number; reason?: string } | 'absent'

/** The round's own diff stats — computed by the driver (git, time), never by this pure module. */
export type RoundStats = {
  baseHead: string
  head: string
  filesChanged: number
  insertions: number
  deletions: number
  wallMs: number
}

/**
 * One round is up to two `assessRound` calls: a `gate` observation (the
 * mechanical check result for the round's new head, carrying the
 * developer's confidence when round ≥ 2 requires one), then, only once the
 * gate passes and confidence clears, a `verdicts` observation. A `gate`
 * observation with `confidence: 'absent'` may repeat once, for the same
 * round, before the loop pauses (spec §6.7's bounded re-ask).
 */
export type Observations =
  | ({ kind: 'gate' } & { round: number; green: boolean; confidence?: Confidence; stats: RoundStats })
  | ({ kind: 'verdicts' } & { round: number; verdicts: VerdictObservation[] })

export type PauseReason = 'escalation' | 'max_rounds' | 'no_progress' | 'confidence' | 'reappearance'

export type Decision =
  | { type: 'dispatch_developer'; reason?: 'confidence' }
  | { type: 'dispatch_reviewers' }
  | { type: 'ask_confidence' }
  | { type: 'publish' }
  | { type: 'pause'; reason: PauseReason }

/**
 * The summary's own outcome vocabulary (O4) — wider than `round_ended`'s
 * schema-constrained `green | changes_requested | escalated`: a round whose
 * processing triggered one of the four O2 exits (max_rounds, no_progress,
 * confidence, reappearance) records `'stopped'` here, even though the log
 * event for that same round still reports `changes_requested` (the schema
 * has no fifth value) — the journal, not the per-event log line, is where
 * the loop's own verdict on that round belongs.
 */
export type RoundOutcome = 'green' | 'changes_requested' | 'escalated' | 'stopped'

/** One row of the published summary (`renderSummary`, O4) — counts only, no finding prose. */
export type RoundRecord = {
  round: number
  countsBySeverity: Record<string, number>
  confidence: Confidence | null
  outcome: RoundOutcome
}

export type Journal = { rounds: RoundRecord[] }

export type LoopConfig = {
  /** Set once by the driver at loop start (`startLoop`, spec §16) — never generated here; this module has no random source. */
  loopId: string
  task: number
  reviewers: string[]
  models: Record<string, string>
}

/** A round awaiting its `verdicts` observation, or awaiting a confidence re-ask — never both logged twice. */
export type PendingRound = {
  round: number
  stats: RoundStats
  confidenceAskCount: number
  confidence: Confidence | null
  /** The id → state map of every prior round combined, for the reappearance/no-progress checks. */
  priorIds: Map<string, string | null>
}

export type LoopState = {
  config: LoopConfig
  rounds: RoundRecord[]
  pending: PendingRound | null
  /** The one extra developer turn the confidence rule (§2) grants after a below-50 round — spent once, ever. */
  extraTurnUsed: boolean
  /** The most recent round's combined id → state map, carried forward for the next round's comparison. */
  lastIds: Map<string, string | null>
  /** Whether the immediately preceding round resolved zero ids — `null` before any round has concluded. */
  previousResolvedEmpty: boolean | null
  /** Running sums for `journal_finalized` — updated once per concluded round, never recomputed from `rounds` (which carries counts only, not diff stats). */
  totalWallMs: number
  totalFilesChanged: number
}

export function initialLoopState(config: LoopConfig): LoopState {
  return {
    config,
    rounds: [],
    pending: null,
    extraTurnUsed: false,
    lastIds: new Map(),
    previousResolvedEmpty: null,
    totalWallMs: 0,
    totalFilesChanged: 0
  }
}
