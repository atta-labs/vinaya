/**
 * The dev-review-loop's own types — the
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

/**
 * The optional fields mirror
 * `ReviewFindingSchema` (`log/schema.ts`) field-for-field — `severityScale`
 * names which scale `severity` is read against (a free string: this
 * doctrine already has a code-review scale and a security scale, and a
 * third reviewer type should never need a schema change to name its own);
 * `policyTreatment` is a SEPARATE fact from `severity` — the same reported
 * severity can bind or not bind a verdict depending on the effective policy
 * threshold and the body-located-prose cap, so the two are never conflated
 * here either; `confidence`/`confidenceScale`/`confidenceSource` are
 * optional and self-reported, left unset rather than fabricated wherever no
 * reviewer grammar produces one yet.
 */
export type FindingObservation = {
  id: string
  severity: string
  state: FindingState
  severityScale?: string
  policyTreatment?: 'blocking' | 'non_blocking' | 'unavailable'
  confidence?: number
  confidenceScale?: string
  confidenceSource?: string
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
  | ({ kind: 'verdicts' } & {
      round: number
      verdicts: VerdictObservation[]
      /**
       * Set when a reviewer's report
       * still carried no citable finding ids after the driver's one resend
       * (`report_uncitable`) — this round's `open`/`resolved` id comparison
       * is untrustworthy, so it is excluded from the `no_progress` check
       * only; every other stop condition (reappearance, confidence,
       * max_rounds, escalation) still applies. Omitted (or `false`) is the
       * default, unchanged behavior.
       */
      findingsUncitable?: boolean
    })

/**
 * `'infrastructure'`: a review
 * role's work directory carried no `findings.txt`/`report.txt` (or, on a
 * task with objectives, no `objectives.txt`) on two consecutive fresh
 * dispatches — never a verdict, a mechanical-gate stall, or an escalation.
 * The driver detects and retries this itself (it reads no verdict here at
 * all); this member exists so the pause it falls back to on a second
 * failure shares the same vocabulary and rendering path every other pause
 * reason already uses, rather than a second, parallel pause shape.
 *
 * `'objectives_changed'`: the
 * objectives version the driver resolved when it dispatched this round's
 * reviewers no longer matches the version it resolves once their verdicts
 * are back — a principal posted an objectives edit mid-round. Like
 * `'infrastructure'`, the driver detects and decides this itself (comparing
 * two resolutions it fetched is not something `assessRound` can do from an
 * `Observations` value); this member exists so that pause shares the same
 * vocabulary and rendering path every other pause reason already uses.
 *
 * `'ruling_posted'`: the newest
 * principal ruling ordinal the driver resolved when it dispatched this
 * round's reviewers no longer matches the ordinal it resolves once their
 * verdicts are back — a principal posted a ruling mid-round. Same shape as
 * `'objectives_changed'` in every respect: the driver detects and decides
 * it itself, and this member exists only so the pause shares the same
 * vocabulary and rendering path every other pause reason already uses.
 *
 * `'stale_driver'`: the base branch
 * moved past a commit touching the driver's own code
 * (`apps/cli/src/lib/dev-review-loop.ts`, `apps/cli/src/commands/
 * review-post.ts`, or this package) since the loop started — same shape
 * again: the driver compares its recorded start-of-loop base head against a
 * freshly re-read one and decides this itself, so a running driver never
 * publishes verdicts an updated gate would refuse.
 *
 * `'brief_superseded'`: the
 * frozen brief's own hash the driver resolved when it dispatched this
 * round's reviewers no longer matches the hash it resolves once their
 * verdicts are back — a Planner superseded the frozen brief mid-round.
 * Same shape as `'objectives_changed'`/`'ruling_posted'`: the driver
 * detects and decides it itself (via the shared `compareManifest`, not a
 * hand-rolled inequality), and this member exists only so the pause shares
 * the same vocabulary and rendering path every other pause reason uses.
 *
 * `'policy_changed'`: the effective review policy's
 * digest the driver resolved at dispatch time no longer matches the one it
 * resolves once verdicts are back — same shape again. In practice a single
 * loop run resolves its policy once and never re-reads it, so this branch
 * is reachable only if a future change makes that re-read live; it exists
 * now so the manifest's comparison is symmetric on every field, matching
 * what the merge gate (which DOES re-resolve policy fresh on every run)
 * already checks.
 *
 * `'no_push'`: a developer turn
 * ended with a dirty worktree or local commits ahead of the remote, and no
 * new head appeared on the branch even after one foreground resume asking
 * it to commit and push. Same shape as the driver-decided reasons above:
 * `devReviewLoop` detects and decides this itself (reading the worktree's
 * own git status, not something `assessRound` can see from an
 * `Observations` value) — it exists only so this pause shares the same
 * vocabulary and rendering path every other pause reason already uses.
 * `detail` is set for this reason too, naming the branch and the dirty
 * file(s) observed.
 */
export type PauseReason =
  | 'escalation'
  | 'max_rounds'
  | 'no_progress'
  | 'confidence'
  | 'reappearance'
  | 'infrastructure'
  | 'no_push'
  | 'objectives_changed'
  | 'ruling_posted'
  | 'stale_driver'
  | 'brief_superseded'
  | 'policy_changed'

export type Decision =
  | { type: 'dispatch_developer'; reason?: 'confidence' }
  | { type: 'dispatch_reviewers' }
  | { type: 'ask_confidence' }
  | { type: 'publish' }
  | {
      type: 'pause'
      reason: PauseReason
      /** Set only for `'infrastructure'` — the role and missing artifact(s) the driver observed; every other reason omits it. */
      detail?: string
    }

/**
 * The summary's own outcome vocabulary — wider than `round_ended`'s
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
  /** The round cap — resolved by the driver from `ReviewPolicy.maxRounds` (repository config), never read here: this module has no config read of its own. */
  maxRounds: number
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
