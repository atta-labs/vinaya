/**
 * Which severities block is repository policy (`review-validity-v1` task 8,
 * `#506`). One pure evaluator behind every site that derives, accepts, or
 * judges a review verdict — `review post`'s derivation and its contradiction
 * check, the dev-review-loop's assessment of a round and its publication
 * self-check, and the merge gate — so no path applies a weaker rule than
 * another (O2).
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

/** (`doctrine-fixes-v1` task 1, `#543`, O4) The dev-review-loop's own round cap, default — replaces the `assess-round.ts` constant this once was; overridable via `reviewPolicy.maxRounds` in `vinaya.config.json`. */
export const DEFAULT_MAX_ROUNDS = 3

/** An omitted policy means today's behaviour (O1): code review at `BLOCKER`, security at `HIGH`, `DEFAULT_MAX_ROUNDS` rounds. */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  codeReviewThreshold: 'BLOCKER',
  securityThreshold: 'HIGH',
  maxRounds: DEFAULT_MAX_ROUNDS
}

export type ReviewPolicy = {
  codeReviewThreshold: CodeReviewSeverity
  securityThreshold: SecuritySeverity
  /** (`#543` O4) The dev-review-loop's own round cap — repository policy, not a hardcoded constant. Resolved once per loop run, same trust class as the two thresholds above. */
  maxRounds: number
}

/** The minimal shape the evaluator needs — every real finding type (review-post.ts's `Finding`, a gate-side severity-only extraction) satisfies it. `location` is optional so a caller with no location to report (an older extraction shape) still type-checks; such a finding is simply never prose-capped (O5, below). */
export type PolicyFinding = { severity: string; location?: string }

/**
 * (`doctrine-fixes-v1` task 1, `#543`, O5) `true` when `location` names the
 * PR body, a PR/review comment, or a role file — prose surfaces this
 * evaluator caps at `MINOR` before counting a finding toward the blocking
 * threshold, regardless of the severity the reviewer actually reported.
 * Never a source or test file: those match none of these patterns.
 */
const PROSE_LOCATION_PATTERNS = [/\bpr\s*body\b/i, /\bcomment\b/i, /(^|\/)aeg-root\/roles\//i] as const

export function isProseLocation(location: string): boolean {
  return PROSE_LOCATION_PATTERNS.some((pattern) => pattern.test(location))
}

/**
 * The severity every prose-located finding is evaluated at, regardless of
 * scale (O5) — literally `'MINOR'`, not "the bottom rung of whichever scale
 * applies": on the code-review scale this is the least severe rank; on the
 * security scale `'MINOR'` is not a member at all, so `blockingSeverities`'s
 * `Set` never contains it and a prose-located security finding never blocks
 * under any configured threshold. Exported so callers rendering a capped
 * finding's effective severity (never its own reported one) share this one
 * literal rather than a second copy of it.
 */
export const PROSE_CAP_SEVERITY = 'MINOR'

export type PolicyEvaluation<F extends PolicyFinding> = {
  outcome: 'clean' | 'blocked'
  /** The findings responsible for blocking — `[]` iff `outcome === 'clean'`. */
  blockingFindings: F[]
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

/**
 * The one pure evaluator (O2). Takes validated findings and an effective
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
  threshold: string
): PolicyEvaluation<F> {
  const blocking = new Set(blockingSeverities(scale, threshold))
  const blockingFindings = findings.filter((f) => {
    if (!scale.includes(f.severity)) {
      throw new Error(`evaluateReviewFindings: severity "${f.severity}" is not one of ${scale.join(' > ')}`)
    }
    // (`#543` O5) Prose never blocks: a finding whose own location is the PR
    // body, a comment, or a role file is evaluated at `PROSE_CAP_SEVERITY`,
    // never its own reported severity — a source or test file location is
    // never capped, and the finding's own reported severity is unchanged
    // (only how it counts toward THIS threshold check is affected).
    const effectiveSeverity = f.location !== undefined && isProseLocation(f.location) ? PROSE_CAP_SEVERITY : f.severity
    return blocking.has(effectiveSeverity)
  })
  return { outcome: blockingFindings.length > 0 ? 'blocked' : 'clean', blockingFindings }
}

/** `evaluateReviewFindings` fixed to the code-review scale and `policy.codeReviewThreshold`. */
export function evaluateCodeReview<F extends PolicyFinding>(
  findings: readonly F[],
  policy: ReviewPolicy
): PolicyEvaluation<F> {
  return evaluateReviewFindings(findings, CODE_REVIEW_SEVERITY_ORDER, policy.codeReviewThreshold)
}

/** `evaluateReviewFindings` fixed to the security scale and `policy.securityThreshold`. */
export function evaluateSecurityReview<F extends PolicyFinding>(
  findings: readonly F[],
  policy: ReviewPolicy
): PolicyEvaluation<F> {
  return evaluateReviewFindings(findings, SECURITY_SEVERITY_ORDER, policy.securityThreshold)
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
