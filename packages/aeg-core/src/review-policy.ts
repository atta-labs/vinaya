/**
 * Which severities block is repository policy. One pure evaluator behind every site that derives, accepts, or
 * judges a review verdict — `review post`'s derivation and its contradiction
 * check, the dev-review-loop's assessment of a round and its publication
 * self-check, and the merge gate — so no path applies a weaker rule than
 * another.
 *
 * Pure — no `fs`, no `fetch`, no `process.env`, no config read, no agent
 * call. The caller resolves the effective policy once (`resolveReviewPolicy`,
 * `apps/cli/src/lib/config.ts`) and passes it in; this module never reads
 * config itself (Traps to avoid).
 *
 * One ordered scale per role, one threshold per scale — never booleans per
 * severity, never two copies of one threshold (Traps to avoid). A finding AT
 * OR ABOVE the threshold (i.e. at the threshold's own rank, or a more severe
 * rank preceding it on the scale) blocks; everything below it does not.
 */

export const CODE_REVIEW_SEVERITY_ORDER = ['BLOCKER', 'MAJOR', 'MINOR'] as const
export type CodeReviewSeverity = (typeof CODE_REVIEW_SEVERITY_ORDER)[number]

export const SECURITY_SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
export type SecuritySeverity = (typeof SECURITY_SEVERITY_ORDER)[number]

/** The dev-review-loop's own round cap, default — replaces the `assess-round.ts` constant this once was; overridable via `reviewPolicy.maxRounds` in `vinaya.config.json`. */
export const DEFAULT_MAX_ROUNDS = 3

/** An omitted policy means today's behaviour: code review at `BLOCKER`, security at `HIGH`, `DEFAULT_MAX_ROUNDS` rounds. */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  codeReviewThreshold: 'BLOCKER',
  securityThreshold: 'HIGH',
  maxRounds: DEFAULT_MAX_ROUNDS
}

export type ReviewPolicy = {
  codeReviewThreshold: CodeReviewSeverity
  securityThreshold: SecuritySeverity
  /** The dev-review-loop's own round cap — repository policy, not a hardcoded constant. Resolved once per loop run, same trust class as the two thresholds above. */
  maxRounds: number
}

/** The minimal shape the evaluator needs — every real finding type (review-post.ts's `Finding`, a gate-side severity-only extraction) satisfies it. `location` is optional so a caller with no location to report (an older extraction shape) still type-checks; such a finding is simply never prose-capped (O5, below). */
export type PolicyFinding = { severity: string; location?: string }

/**
 * A location shaped like a real file reference — a path ending in a
 * `.<ext>` segment, optionally followed by `:<line>` — the shape every
 * `findings.txt` location actually takes (`SEVERITY|file:line|description`).
 * Round 2 review, BLOCKER: `/\bcomment\b/i` alone matched `comment` as a
 * plain substring, so a real test file whose NAME happens to contain the
 * word (`apps/cli/tests/commands/pr-create-brief-comment.test.ts`) was
 * wrongly treated as "the finding's location is a comment" and capped to
 * `MINOR` — exactly the trap O5's own brief forbids (never cap a source or
 * test file). Gating the comment pattern on "does NOT also look like a real
 * file" closes this: a genuine PR/review-comment location the reviewer
 * writes (`PR comment`, `a review comment`, bare `comment`) never carries a
 * file extension, so it is unaffected.
 */
const FILE_SHAPED_LOCATION = /\.[a-zA-Z0-9]{1,10}(:\d+)?\s*$/

/**
 * `true` when `location` names the
 * PR body or a PR/review comment — prose surfaces this evaluator caps at
 * `MINOR` before counting a finding toward the blocking threshold, regardless
 * of the severity the reviewer actually reported. Each of these, gated on
 * `FILE_SHAPED_LOCATION` below (a LOW round-2 review finding): a real file
 * whose own name happens to contain one of these words or phrases —
 * `apps/cli/tests/commands/pr-create-brief-comment.test.ts`, or any of the
 * repo's own `pr-body-*.md` fixtures — is a source or test file, never
 * prose, no matter which of these patterns its path text also matches. The
 * `aeg-root/roles/` pattern is deliberately NOT in this group and is checked
 * separately, ungated: it IS a real file, and is still prose by this task's
 * own design (see `isProseLocation` below).
 */
const PROSE_LOCATION_PATTERNS = [/\bpr\s*body\b/i, /\bcomment\b/i] as const

/** A role doc IS a file, yet still counts as prose — the one deliberate exception the file-shape gate never applies to. */
const ROLE_FILE_LOCATION = /(^|\/)aeg-root\/roles\//i

export function isProseLocation(location: string): boolean {
  if (ROLE_FILE_LOCATION.test(location)) return true
  if (FILE_SHAPED_LOCATION.test(location)) return false
  return PROSE_LOCATION_PATTERNS.some((pattern) => pattern.test(location))
}

/**
 * The severity every prose-located finding is evaluated at, regardless of
 * scale — literally `'MINOR'`, not "the bottom rung of whichever scale
 * applies": on the code-review scale this is the least severe rank; on the
 * security scale `'MINOR'` is not a member at all, so `blockingSeverities`'s
 * `Set` never contains it and a prose-located security finding never blocks
 * under any configured threshold. Exported so callers rendering a capped
 * finding's effective severity (never its own reported one) share this one
 * literal rather than a second copy of it.
 */
export const PROSE_CAP_SEVERITY = 'MINOR'

/** A finding that would block under the plain threshold but this round cannot act on — carried out of the evaluator so the summary and gate can report it (O4). */
export type DeferredFinding<F extends PolicyFinding> = { finding: F; reason: DeferralReason }

export type PolicyEvaluation<F extends PolicyFinding> = {
  outcome: 'clean' | 'blocked'
  /** The findings responsible for blocking — `[]` iff `outcome === 'clean'`. */
  blockingFindings: F[]
  /**
   * The findings that WOULD have blocked but were set aside this round by the
   * unchanged-line or out-of-Surface rule (O4). Always `[]` when no
   * `FindingDeferralContext` was supplied — every existing caller that passes
   * none sees exactly the outcome it did before this task, a deferral list
   * that is simply empty.
   */
  deferredFindings: DeferredFinding<F>[]
}

/**
 * Every severity on `scale` at or above `threshold`'s own rank — `scale`
 * ordered most-to-least severe, so this is the prefix of `scale` ending at
 * `threshold` inclusive. Throws if `threshold` is not on `scale`: an unknown
 * threshold value is a caller defect, never silently treated as "nothing
 * blocks" or "everything blocks."
 */
export function blockingSeverities(scale: readonly string[], threshold: string): string[] {
  const idx = scale.indexOf(threshold)
  if (idx === -1) {
    throw new Error(`blockingSeverities: threshold "${threshold}" is not one of ${scale.join(' > ')}`)
  }
  return scale.slice(0, idx + 1)
}

/** Why a finding that WOULD block under the plain threshold is set aside for this round instead — reported, never silently dropped (O4). */
export type DeferralReason = 'unchanged-line' | 'outside-surface'

/**
 * O4's human-readable prose for each `DeferralReason` — the one place the
 * machine reason is worded for a reader, so the round summary
 * (`render-summary.ts`) and the merge gate (`review-gate.ts`) name a deferral
 * identically rather than each spelling it their own way.
 */
export const DEFERRAL_REASON_TEXT: Record<DeferralReason, string> = {
  'unchanged-line': 'unchanged line',
  'outside-surface': 'outside the Surface'
}

/**
 * The single verdict `classifyFinding` returns:
 *   - `'blocking'` — at or above threshold, in the Surface, on a changed line
 *     (or the round-1/no-previous-head case where the unchanged-line rule does
 *     not apply), or a security finding at or above HIGH the unchanged-line
 *     rule never defers;
 *   - `'deferred'` — WOULD block, but this round cannot act on it: outside the
 *     Surface (any round, O3) or on a line that did not change since the
 *     previous round's head (round 2 on, O2). `deferralReason` names which;
 *   - `'non_blocking'` — below threshold, or a prose-located finding capped to
 *     `PROSE_CAP_SEVERITY` (O5). Never deferred: it was never going to block,
 *     so there is nothing to report as set-aside.
 */
export type FindingPolicyOutcome = 'blocking' | 'deferred' | 'non_blocking'

export type FindingClassification = {
  outcome: FindingPolicyOutcome
  /** Set iff `outcome === 'deferred'`; `null` otherwise. */
  deferralReason: DeferralReason | null
}

/**
 * The round-dependent facts the deferral rules need, supplied by the caller
 * (never resolved here — this module stays pure, no `git`, no glob, no forge
 * read). Each predicate is OPTIONAL, and its absence is the "rule inactive"
 * case, not "rule fails":
 *
 *   - `changedLine` — active only from round 2 on, and only when the caller
 *     could recover the previous round's head: `changedLine(location)` is
 *     `true` when the finding's own line changed between the previous round's
 *     head and the current head (a file-level finding on a file that changed
 *     counts as changed — the caller's own predicate decides this, per the
 *     brief's own trap). Undefined means the unchanged-line rule (O2) is NOT
 *     applied at all — round 1 has no previous head, and a CI gate that cannot
 *     recover one treats every in-Surface finding as blocking rather than
 *     guessing. Never inferred here from a `false` return.
 *   - `inSurface` — `inSurface(location)` is `true` when the finding's file is
 *     covered by the task's `## Surface` `in:` list. Undefined means the
 *     Surface is not known to this caller, so the out-of-Surface rule (O3) is
 *     not applied — never a silent "everything is out of Surface."
 */
export type FindingDeferralContext = {
  changedLine?: (location: string) => boolean
  inSurface?: (location: string) => boolean
}

/**
 * A security finding at or above HIGH — the one exception to the
 * unchanged-line rule (O2): it blocks wherever it sits, even on a line the
 * round did not touch. Derived from the security scale so it is exactly
 * `CRITICAL` and `HIGH`; those two severities exist on no other scale, so
 * membership alone identifies a security finding of that rank without needing
 * to know which scale the caller passed. The out-of-Surface rule (O3) carries
 * NO such exception — a finding outside the Surface never blocks, security or
 * not — so this is consulted only on the unchanged-line path below.
 */
const SECURITY_HIGH_AND_ABOVE: readonly string[] = blockingSeverities(SECURITY_SEVERITY_ORDER, 'HIGH')

/**
 * The ONE function that decides whether a review finding blocks this round —
 * O1's single rule, behind the merge gate (`review-gate.ts`) and the loop's
 * own classifier (`reviewer-dispatch.ts`) alike, so neither keeps its own
 * copy. Pure, and total: it applies, in order,
 *
 *   1. the prose cap (O5) — a PR-body / comment / role-file location is
 *      evaluated at `PROSE_CAP_SEVERITY`, so it can never reach the threshold;
 *   2. the threshold — below it, `'non_blocking'` (never deferred: a finding
 *      that was never going to block is not "set aside", it simply passes);
 *   3. the out-of-Surface rule (O3) — a would-block finding whose file the
 *      Surface `in:` does not cover is `'deferred'`, ANY round, no exception;
 *   4. the unchanged-line rule (O2) — from round 2 on (`context.changedLine`
 *      present), a would-block finding on an unchanged line is `'deferred'`,
 *      EXCEPT a security finding at or above HIGH, which blocks anyway.
 *
 * The finding's own reported severity is never mutated — only how it counts
 * toward this round's block decision is (Traps to avoid: "retain reported
 * severity separately from the incoming prose cap").
 */
export function classifyFinding(
  finding: PolicyFinding,
  scale: readonly string[],
  threshold: string,
  context: FindingDeferralContext = {}
): FindingClassification {
  if (!scale.includes(finding.severity)) {
    throw new Error(`classifyFinding: severity "${finding.severity}" is not one of ${scale.join(' > ')}`)
  }
  const location = finding.location
  const effectiveSeverity = location !== undefined && isProseLocation(location) ? PROSE_CAP_SEVERITY : finding.severity
  const wouldBlock = blockingSeverities(scale, threshold).includes(effectiveSeverity)
  if (!wouldBlock) return { outcome: 'non_blocking', deferralReason: null }

  // A locatable would-block finding — every deferral rule below needs a
  // location to test. A finding carrying none (an older extraction shape with
  // no `file:line`) can be tested by neither rule, so it blocks, the
  // fail-closed default this task's own trap names for an unrecoverable case.
  const hasLocation = location !== undefined && location.length > 0

  // O3 first: findings outside the Surface never block, in ANY round, with no
  // security exception — so it is decided before the unchanged-line rule.
  if (hasLocation && context.inSurface && !context.inSurface(location as string)) {
    return { outcome: 'deferred', deferralReason: 'outside-surface' }
  }

  // O2: the unchanged-line rule, active only when the caller supplied a
  // changed-line predicate (round 2 on, previous head recovered). A security
  // finding at or above HIGH is the one exception and blocks regardless.
  if (hasLocation && context.changedLine && !SECURITY_HIGH_AND_ABOVE.includes(effectiveSeverity)) {
    if (!context.changedLine(location as string)) {
      return { outcome: 'deferred', deferralReason: 'unchanged-line' }
    }
  }

  return { outcome: 'blocking', deferralReason: null }
}

/**
 * The one pure evaluator. Takes validated findings and an effective
 * policy threshold on an ordered severity scale; returns the outcome and the
 * findings responsible for blocking. Throws if any finding's own severity is
 * not on `scale` — findings reaching this function are expected to already
 * be validated against the same scale (`parseFindingsFile`, a gate-side
 * extraction), so an unrecognized severity here is a caller defect, not a
 * value to silently ignore.
 */
export function evaluateReviewFindings<F extends PolicyFinding>(
  findings: readonly F[],
  scale: readonly string[],
  threshold: string,
  context: FindingDeferralContext = {}
): PolicyEvaluation<F> {
  const blockingFindings: F[] = []
  const deferredFindings: DeferredFinding<F>[] = []
  for (const f of findings) {
    // `classifyFinding` throws on an unrecognized severity (a caller defect),
    // applies the prose cap (O5), and — when `context` carries them — the
    // out-of-Surface (O3) and unchanged-line (O2) rules. With no context it
    // reduces to the plain prose-capped threshold check this function was.
    const c = classifyFinding(f, scale, threshold, context)
    if (c.outcome === 'blocking') blockingFindings.push(f)
    else if (c.outcome === 'deferred') deferredFindings.push({ finding: f, reason: c.deferralReason as DeferralReason })
  }
  return { outcome: blockingFindings.length > 0 ? 'blocked' : 'clean', blockingFindings, deferredFindings }
}

/**
 * O4: the SINGLE definition of "does this finding count toward policy." A
 * finding is consequential — evaluated by `evaluateReviewFindings` and able to
 * block — unless the reviewer marked it `resolved`. Any other state (`open`,
 * `fix-claimed`, `reproduced`) and a finding carrying no state token at all
 * stay consequential and still block (O2, fail-closed): only an explicit
 * `resolved` clears a finding from the gate, so a reviewer cannot clear a real
 * blocker by relabelling it anything else. Imported by verdict derivation
 * (`deriveCodeReviewVerdict`/`deriveSecurityVerdict`), the merge gate
 * (`checkReviewGate`), and the loop's publication self-check (`publishRound`)
 * alike, so the three can never disagree about the same verdict comment. The
 * re-review-state grammar itself is parsed once, by `parseFindingState`
 * (`verdict-extraction.ts`); this rule only decides what a parsed state means
 * for policy.
 */
export function isConsequentialFinding(finding: { state?: string | null }): boolean {
  return finding.state !== 'resolved'
}

/** Every consequential finding (see `isConsequentialFinding`), preserving order and element type. */
export function consequentialFindings<F extends { state?: string | null }>(findings: readonly F[]): F[] {
  return findings.filter((f) => isConsequentialFinding(f))
}

/** `evaluateReviewFindings` fixed to the code-review scale and `policy.codeReviewThreshold`. `context` threads the deferral rules through; omitted, the evaluation is the plain prose-capped threshold check it was. */
export function evaluateCodeReview<F extends PolicyFinding>(
  findings: readonly F[],
  policy: ReviewPolicy,
  context: FindingDeferralContext = {}
): PolicyEvaluation<F> {
  return evaluateReviewFindings(findings, CODE_REVIEW_SEVERITY_ORDER, policy.codeReviewThreshold, context)
}

/** `evaluateReviewFindings` fixed to the security scale and `policy.securityThreshold`. `context` threads the deferral rules through; omitted, the evaluation is the plain prose-capped threshold check it was. */
export function evaluateSecurityReview<F extends PolicyFinding>(
  findings: readonly F[],
  policy: ReviewPolicy,
  context: FindingDeferralContext = {}
): PolicyEvaluation<F> {
  return evaluateReviewFindings(findings, SECURITY_SEVERITY_ORDER, policy.securityThreshold, context)
}

/** The code-review scale's blocking subset under `policy` — `blockingSeverities(CODE_REVIEW_SEVERITY_ORDER, policy.codeReviewThreshold)`. */
export function codeReviewBlockingSeverities(policy: ReviewPolicy): string[] {
  return blockingSeverities(CODE_REVIEW_SEVERITY_ORDER, policy.codeReviewThreshold)
}

/** The security scale's blocking subset under `policy` — `blockingSeverities(SECURITY_SEVERITY_ORDER, policy.securityThreshold)`. */
export function securityBlockingSeverities(policy: ReviewPolicy): string[] {
  return blockingSeverities(SECURITY_SEVERITY_ORDER, policy.securityThreshold)
}

/**
 * `true` when `value` is one of `scale`'s own members — the runtime check
 * behind O1's "an unknown severity or threshold value refuses at config
 * load, never falls back." Exported so `apps/cli/src/lib/config.ts`'s
 * `resolveReviewPolicy` can validate a configured threshold against the
 * SAME scale this module evaluates against, rather than a second copy.
 */
export function isKnownSeverity(scale: readonly string[], value: string): boolean {
  return scale.includes(value)
}
