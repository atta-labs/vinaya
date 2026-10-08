/**
 * The dev-review-loop's own types — the
 * policy half of the loop spec (Linear "Tech spec — Developer Review Loop",
 * rev 4, §16). Pure — no `fs`, no `fetch`, no `process.env`, no vendor name,
 * no prompt anywhere in this directory.
 */

import type { DevReviewLoopEvent } from '../log'
import type { DeferralReason } from '../review-policy'

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

/** O4's fixed column order — shared by `assess-round.ts` (counting) so every round records the same columns. */
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
  /**
   * The finding's own `file:line` (O4) — carried so the round record can name
   * every deferred finding's location. Optional: an older extraction shape, or
   * a finding with none, simply has none to report.
   */
  location?: string
  /** Reviewer-written text, redacted and visibly capped at capture. */
  description?: string
  /**
   * The finding's normalized description (lower-cased, whitespace and
   * punctuation collapsed), built where reviewer output is parsed. The
   * repeat-finding stop compares it with role and file, never the positional
   * `id`. Optional: an observation without one falls back to its `id`.
   */
  fingerprint?: string
  state: FindingState
  severityScale?: string
  policyTreatment?: 'blocking' | 'non_blocking' | 'unavailable'
  /**
   * Set only when the round set this finding aside rather than let it block
   * (O2/O3): `'unchanged-line'` (round 2 on, a line that did not change) or
   * `'outside-surface'` (any round, a file the Surface `in:` does not cover).
   * Absent means the finding was NOT deferred — it blocked, or was below
   * threshold. `policyTreatment` reads `non_blocking` whenever this is set.
   */
  deferred?: DeferralReason
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
  | ({ kind: 'gate' } & {
      round: number
      green: boolean
      confidence?: Confidence
      stats: RoundStats
      /**
       * The mechanical failure that made this gate red, verbatim — the
       * failing check-run names and premise re-assert messages the driver
       * already holds, exactly as it would print them. Read only when
       * `green` is false, and only to match this attempt's failure against
       * the previous one's (`normalizeFailureSignature`, `assess-round.ts`);
       * a red gate whose cause the driver could not name omits it, which
       * breaks the repeat chain rather than matching an unknown to an
       * unknown.
       */
      failure?: string
    })
  | ({ kind: 'verdicts' } & {
      round: number
      verdicts: VerdictObservation[]
    })
  /**
   * A mechanical failure that ended an attempt WITHOUT producing a head for
   * the gate to read — a push the developer could not land (refused by a
   * pre-push hook, or by the remote), or a turn that pushed nothing at all.
   * There is no gate result to report for such an attempt, so it cannot
   * arrive as a `gate` observation; it carries only the failure the driver
   * observed, which the same `'repeat_failure'` rule matches against the
   * previous attempt's. Unlike a `gate` observation, a non-repeat here
   * records nothing but the signature: no round record, no events, no round
   * accounting — the attempt produced no head, so there is nothing about it
   * to publish, and the driver's own bounds (one resume then `'no_push'`,
   * the stalled-head bound then `'infrastructure'`) still govern a first
   * occurrence.
   */
  | ({ kind: 'mechanical_failure' } & { round: number; failure: string; stats: RoundStats })

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
 * `'repeat_finding'`: the same blocking finding — same reviewer role, same
 * finding id — was still open in two consecutive reviewed rounds. Unlike
 * `'reappearance'` (an id the reviewer itself marked `resolved` and then
 * reported again), nothing here was ever claimed fixed: the finding simply
 * never left, and a third developer turn on it is a turn the loop has no
 * reason to expect anything new from. Decided by `assessRound`, which
 * carries the repeated key(s) in the pause's own `detail`.
 *
 * `'repeat_failure'`: two consecutive attempts ended on the same mechanical
 * failure — a refused push, a premise re-check mismatch, a forge or network
 * error, a failed pre-push test — matched by the normalised signature
 * `normalizeFailureSignature` derives (`assess-round.ts`), never by raw
 * string equality: the volatile parts of such a message (timestamps,
 * temporary paths, process ids, durations) differ between two runs of the
 * SAME failure. The driver reports the failure text it already has on the
 * gate observation; the pause's `detail` is that exact message, unnormalised.
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
 *
 * `'time_budget'`: the task's ACTIVE working time — the sum of the phases a
 * driver spent developing, reviewing and awaiting confidence, never the hours
 * it sat paused, published or driverless — passed `ReviewPolicy.maxTaskMinutes`.
 * Unlike every other bound here it counts neither rounds nor attempts, so it is
 * the one stop a loop cannot outrun by never advancing: time spent pushing,
 * rebasing, waiting on checks and retrying all counts toward it (it is recorded
 * as developing), while time waiting on a Principal does not. Decided by
 * `assessRound` from the clock its caller reads (this module has none of its
 * own); `detail` names the budget, the active time spent, and the active phases
 * that time was summed from.
 */
export type PauseReason =
  | 'escalation'
  | 'max_rounds'
  | 'no_progress'
  | 'confidence'
  | 'reappearance'
  | 'repeat_finding'
  | 'repeat_failure'
  | 'time_budget'
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
      /**
       * The pause's own narration, when the deciding component has one:
       * `'infrastructure'` (the role and missing artifact(s) the driver
       * observed), `'max_rounds'` (the configured cap), `'repeat_finding'`
       * (the reviewer-qualified finding key(s) open two rounds running),
       * `'repeat_failure'` (the exact failure message, unnormalised), and
       * `'time_budget'` (the budget, the active time spent, and the active
       * phases it was summed from). Every
       * other reason omits it here — the driver narrates several of them
       * itself from facts it already holds (`deriveVerdictPauseDetail`).
       */
      detail?: string
    }

/**
 * The journal's own outcome vocabulary — wider than `round_ended`'s
 * schema-constrained `green | changes_requested | escalated`: a round whose
 * processing triggered one of the assessment exits (max_rounds, confidence,
 * reappearance) records `'stopped'` here, even though the log
 * event for that same round still reports `changes_requested` (the schema
 * has no fifth value) — the journal, not the per-event log line, is where
 * the loop's own verdict on that round belongs.
 */
export type RoundOutcome = 'green' | 'changes_requested' | 'escalated' | 'stopped'

/**
 * Why a round ended before any reviewer ran, for the journal's outcome
 * cell. A round no reviewer saw has no findings from any source, so it records
 * no counts at all (an empty `countsBySeverity`)
 * rather than a zero that reads as a clean review — and this names the reason
 * the outcome cell states instead of the log-parity `outcome` a reviewed round
 * carries:
 *
 *   - `'checks_red'` — the round's gate observation was not green, so reviewers
 *     were never dispatched;
 *   - `'low_confidence'` — a below-threshold confidence sent the developer back
 *     without dispatching reviewers;
 *   - `'mechanical_failure'` — the same mechanical failure ended two
 *     consecutive attempts that never produced a head (`'repeat_failure'`),
 *     so no gate ever judged one and no reviewer ever saw it;
 *   - `'time_budget'` — the task's wall-clock budget ran out before this
 *     round reached review, so reviewers were never dispatched for it.
 *
 * `outcome` stays whatever the round would otherwise carry (both reasons are
 * `changes_requested` today), so the `round_ended` log event a reader parses is
 * unaffected — only the `RoundRecord` the journal carries changes.
 */
export type NotReviewedReason = 'checks_red' | 'low_confidence' | 'mechanical_failure' | 'time_budget'

/** One deferred finding, as the journal records it (O4) — its original severity, its `file:line`, and why this round set it aside, never its reported severity mutated. */
export type DeferredFindingRow = {
  severity: string
  /** The finding's own `file:line`, or `''` when it carried none. */
  location: string
  reason: DeferralReason
  description?: string
}

/** One round of the journal (O4) — counts only, no finding prose. */
export type RoundRecord = {
  round: number
  countsBySeverity: Record<string, number>
  confidence: Confidence | null
  outcome: RoundOutcome
  /**
   * Every finding this round set aside rather than let it block (O2/O3),
   * carried so a reader can list each with its original severity,
   * location and reason (O4). Absent/`[]` for a round that deferred none, and
   * for a marker-reconstructed round (its findings are unknown — see
   * `journal-reconstruction.ts`).
   */
  deferred?: DeferredFindingRow[]
  /**
   * Set only for a round no reviewer saw (`buildUnreviewedRecord`,
   * `assess-round.ts`): its counts are absent (empty `countsBySeverity`) and the
   * the round's outcome names this reason. Absent for every round the loop
   * assessed and for a round rebuilt from a marker — a marker-reconstructed
   * round's counts are likewise unknown, but the round DID reach review, so it
   * keeps its `outcome`, not a not-reviewed reason.
   */
  notReviewed?: NotReviewedReason
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
  /** The task's wall-clock budget in minutes — resolved by the driver from `ReviewPolicy.maxTaskMinutes`, same discipline as `maxRounds` above. `0` turns the budget off. */
  maxTaskMinutes: number
}

/**
 * How long this task has been running, and where that time went — read by the
 * DRIVER and handed to `assessRound`, never measured here: this module has no
 * clock, the same way it has no config read.
 *
 * `elapsedMs` is the task's ACTIVE working time: the sum of the phases a driver
 * spent working the task forward (`activeBudgetMs` over `byPhaseMs` —
 * developing, reviewing, awaiting confidence), and nothing else. Time the task
 * sat `paused` waiting for a Principal, time it spent `publishing` an approved
 * pull request, and any stretch with no driver running at all are excluded — so
 * a task first started days ago is measured by the minutes it worked, not by
 * its age. It is a sum over per-phase times the durable control records carry
 * across a restart, so a driver that was killed, taken over, or re-execed
 * itself continues one budget rather than beginning a fresh one.
 *
 * `byPhaseMs` is the FULL record of what the loop recorded against each phase
 * it worked in, keyed by the phase names the loop persists (`dispatch_developer`,
 * `dispatch_reviewers`, and so on) — inactive phases (`pause`, `publish`)
 * included, so it is a faithful account of where all the time went. The budget
 * is decided on `elapsedMs`, which sums only the active subset; a breakdown
 * that is thin — a run whose earlier phases were recorded by a driver that has
 * since died — still stops on time and simply reports less about where the
 * time went. The `'time_budget'` pause's detail names only the active phases
 * (`renderTaskBudgetDetail`), so the phases it lists sum to the time it reports
 * as spent.
 */
export type TaskClock = {
  elapsedMs: number
  byPhaseMs: Record<string, number>
}

/** A round awaiting its `verdicts` observation, or awaiting a confidence re-ask — never both logged twice. */
export type PendingRound = {
  round: number
  stats: RoundStats
  confidenceAskCount: number
  confidence: Confidence | null
  /** The id → state map of every prior round combined, for the reappearance check. */
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
  /**
   * The previous REVIEWED round's blocking-and-open finding keys
   * (`<role>:<id>`, sorted), for the `'repeat_finding'` stop. Rounds no
   * reviewer saw (a red gate, a low-confidence turn) never touch it: two
   * consecutive rounds means two consecutive rounds that produced verdicts,
   * not two iterations of the driver's loop.
   */
  lastBlockingFindings: string[]
  /**
   * The previous attempt's mechanical failure — its normalised `signature`
   * (what two attempts are matched on) and the `message` as reported (what
   * the pause names). `null` whenever the last attempt reached a green gate,
   * or failed with no reported cause: either breaks the repeat chain.
   */
  lastFailure: { signature: string; message: string } | null
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
    lastBlockingFindings: [],
    lastFailure: null,
    totalWallMs: 0,
    totalFilesChanged: 0
  }
}
