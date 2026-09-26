/**
 * Required pre-merge review gate. Blocks a
 * PR from merging unless a clean code-reviewer `APPROVE` verdict
 * AND a clean security-review `PASS` verdict both exist on the PR — the same
 * `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` detection
 * (`verdict-extraction.ts`) the post-merge Archivist automation already runs,
 * now gated pre-merge and blocking instead of post-merge and advisory-only.
 *
 * Verdict comments are ONLY counted when their author is on the same
 * `PRINCIPAL_ALLOWLIST` the waiver actor-check trusts (a security finding):
 * body-shape alone is never sufficient on a public repo. Unverified
 * comments are ignored, not fatal.
 *
 * A verified `vinaya/waiver:review` label (the exact actor-verification pattern,
 * `isWaiverLabelActorVerified` reused directly and parameterized by label —
 * see `waiver-label.ts`) lets a principal explicitly skip the requirement for
 * one PR. Label presence alone is never sufficient — only an actor-verified
 * label waives the gate, mirroring exactly.
 *
 * Reviewed-commit binding. A clean
 * verdict is no longer sufficient on its own — it must also cover the PR's
 * CURRENT head. Design record (the four questions this fix had to answer,
 * argued in full in the closing PR's body):
 *
 * 1. Commit sha, not tree hash. `headSha` is `gh pr view --json headRefOid`
 *    verbatim — one API call, no second fetch of a commit object's tree.
 *    Matches the Issue's own proposed fix shape and the hand-typed
 *    convention reviewers were already using ("Judged head: <sha>", never a
 *    tree hash). Cost accepted: a rebase or an empty amend that leaves the
 *    tree byte-identical still invalidates every verdict — no free pass for
 *    "the code didn't really change." That is the explicit trade for a
 *    single mental model ("a verdict covers an exact commit") over a cheaper
 *    but subtler one (two different code states could share a tree).
 * 2. Every push that changes `headRefOid` invalidates unconditionally — a
 *    rebase with an identical tree, a merge commit resolving a conflict
 *    elsewhere, and a genuine content-changing amend all produce a new sha
 *    and therefore a new required verdict. Only a push that does NOT change
 *    `headRefOid` at all (a body-only PR-description edit; a force-push that
 *    reproduces the exact same commit object) leaves an existing binding
 *    intact, because there is nothing for it to have gone stale against.
 * 3. `headSha` is REQUIRED on `ReviewGateInput`, not optional. An optional
 *    field that silently skips the binding check when absent is fail-open —
 *    exactly the defect class this task exists to close. Every caller
 *    (`bin/verify-review-gate.ts`, `apps/cli/src/checks/bin/check-review-gate.ts`)
 *    must supply it; the type system enforces that, not a runtime default.
 * 4. Fail-closed for the transition. The moment this merges, every verdict
 *    already posted on an open PR is unbound (it carries no `Judged head:`
 *    line) and the gate stops honouring it — expensive, and correct: an
 *    unbound verdict is exactly the property this task closes. The sanctioned
 *    escape for a PR already far along in review is the existing
 *    `vinaya/waiver:review` actor-verified label, applied by a principal, the
 *    same mechanism that already exists for any other one-off skip.
 *
 * Ruling-freshness binding. A
 * verdict is also bound to the newest PRINCIPAL RULING on the PR at cast
 * time, the same shape as the objectives-version binding above but with
 * `0` (never `null`) standing in for "nothing to bind against yet" — a
 * ruling's existence on a PR is never ambiguous the way an Issue's
 * objectives-cutover status is, so there is no "skip this binding" input
 * value here. `input.rulingOrdinal` is the caller-resolved newest ordinal
 * (`isBoundToRulings`, below); a verdict cast against an older ordinal, or
 * carrying no `Ruling ordinal:` line at all on a PR that now has one,
 * reads as unbound — a ruling posted after approval turns a previously
 * clean gate red until reviewers re-cast against it.
 *
 * This gate answers one question — are the required review verdicts present,
 * clean, and bound to what is being merged — and nothing else. It reads no
 * other check's result and no Test Plan tick-state; each of those is its own
 * check, owned elsewhere.
 *
 * Pure — no `fs`, no `fetch`, no `process.env`. The CLI shim
 * (`bin/verify-review-gate.ts`) resolves the PR's comments/labels/label-actor/
 * head sha via `gh` and calls `checkReviewGate`.
 */

import { isPrincipal, isWaiverLabelActorVerified, PRINCIPAL_ALLOWLIST, WAIVER_LABEL_REVIEW } from './waiver-label'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from './verdict-extraction'
import {
  consequentialFindings,
  DEFAULT_REVIEW_POLICY,
  evaluateCodeReview,
  evaluateSecurityReview,
  type ReviewPolicy
} from './review-policy'
import {
  compareManifest,
  policyDigest as computePolicyDigest,
  type EchoedManifest,
  type ReviewInputManifest
} from './review-input-manifest'

export type ReviewGateVerdict = 'pass' | 'fail'

export type ReviewGateResult = {
  verdict: ReviewGateVerdict
  reason: string
  waived: boolean
}

export type ReviewGateComment = {
  body: string
  /** The comment author's GitHub login, or `null` when the caller could not resolve one. */
  author: string | null
}

export type ReviewGateInput = {
  /** Every comment on the PR, with its author. */
  comments: ReviewGateComment[]
  /** Every label currently applied to the PR. */
  labels: string[]
  /** Actor of the most recent `vinaya/waiver:review` labeling timeline event, or `null` when none exists. */
  waiverLabelActor: string | null
  /**
   * The PR's current head commit sha (`gh pr view --json headRefOid`),
   * resolved from GitHub — never from local git, an env var, or the PR's own
   * checkout, all three of which a `pull_request`-triggered workflow's
   * PR-editable YAML could steer. REQUIRED, not optional: an omitted
   * head would have to mean either skip-the-binding-check (fail-open, the
   * exact defect this field exists to close) or unconditional-fail, and a
   * required field makes that choice a compile error instead of a runtime
   * default. Every verdict must cover this value to count as clean.
   */
  headSha: string
  /**
   * Overrides `PRINCIPAL_ALLOWLIST` for this evaluation when provided — an
   * adopter repo's own `vinaya.config.json` `principals` field, resolved by
   * the CLI bin before calling in (never read from here; this stays pure).
   * Defaults to `PRINCIPAL_ALLOWLIST` when omitted, so every existing caller
   * (this repo's own `bin/verify-review-gate.ts` included) is unaffected.
   * `PRINCIPAL_ALLOWLIST` hardcoding this repo's own principal made the gate
   * structurally unpassable on any adopter repo — found live on a real
   * client repo's first dispatched task, the reviewer/security verdicts it
   * already had counted for nobody.
   */
  principalAllowlist?: string[]
  /**
   * The PATCH IDENTITY of a commit — `git diff <base>...<sha> | git patch-id
   * --stable`, truncated — or `null` when git cannot answer for that sha
   * (an unreachable commit after a force-push, a shallow clone, no git at
   * all). Supplied by the caller because this module is pure; omitted
   * entirely, the gate behaves exactly as before.
   *
   * Why a second binding at all: a verdict was judged, the branch merged
   * `origin/main` to clear a stale base, and the verdict died — for a merge
   * commit that changed not one line of the PR's own patch. Re-reviewing
   * an identical patch is a round spent proving nothing. Patch identity is
   * what a reviewer actually judged; the head sha is only its address.
   *
   * Two known limits, stated rather than papered over.
   *
   * A base that moved under an identical patch can carry a semantic conflict
   * the earlier review could not have seen, and this binding will still
   * hold. That is the same limit GitHub's own stale-review rule has, and CI
   * at the new head — a required check in its own right, never read from
   * here — is the guard for it.
   *
   * `git patch-id --stable` ignores whitespace, so a push that changes only
   * whitespace produces the same patch identity and KEEPS the verdict. That
   * is deliberate for reformatting, but it is not free: whitespace is
   * semantic in some languages and some string literals, so a push that is
   * whitespace-only to git can still change behaviour. Any change to
   * non-whitespace content produces a different identity and correctly drops
   * the verdict; only the whitespace-only case survives unreviewed.
   */
  patchIdOf?: (sha: string) => string | null
  /**
   * The current `objectivesVersion` of the list the PR is judged against
   * — the Issue's `objectivesOf`
   * build, or the PR body's own `## Objectives` section below the cutover,
   * resolved by the caller (never here; this stays pure). `null` means the
   * objectives binding is SKIPPED entirely — a pre-cutover Issue, no Issue at
   * all, or no objectives section resolvable — so the pre-cutover PR stock
   * keeps passing exactly as it did before this field existed. A non-null
   * value requires every clean verdict's own `extraction.objectivesVersion`
   * to equal it; a mismatch (including a verdict with no version line at
   * all) reads as unbound, the same fail-closed shape as a stale head.
   */
  objectivesVersion: string | null
  /**
   * The newest principal ruling ordinal on this PR — `0` when the PR carries no ruling at all, NEVER
   * `null`: unlike `objectivesVersion`, there is no "skip this binding"
   * case here — a PR either has rulings or it doesn't, and `0` says so.
   * Resolved by the caller (never here; this stays pure) by counting
   * principal-authored `<!-- aeg:principal:ruling:<pr>-<k> -->` comments.
   * A verdict's own `extraction.rulingOrdinal` binds only when it equals
   * this value exactly — `null` (pre-cutover stock, no `Ruling ordinal:`
   * line at all) binds only when this value is `0`, the same "the PR truly
   * had nothing to see" case `isBoundToObjectives`'s `null`-current-version
   * skip covers for objectives, but expressed as equality rather than an
   * unconditional skip, since a ruling's existence is never ambiguous.
   */
  rulingOrdinal: number
  /**
   * Which severities block is repository policy — resolved by the caller from the DEFAULT BRANCH's
   * `vinaya.config.json` (`resolveReviewPolicy(loadTrustAnchorConfig())`),
   * never from here (this stays pure) and never from the PR's own checkout,
   * so a change cannot lower its own threshold. Defaults to
   * `DEFAULT_REVIEW_POLICY` (`BLOCKER`/`HIGH`) when omitted — every existing
   * caller that predates this field is unaffected, the same optional-with-
   * fallback shape `principalAllowlist` already uses above.
   */
  policy?: ReviewPolicy
  /**
   * The frozen brief's own hash at evaluation time — resolved by the caller (never here; this stays
   * pure) from the linked Issue's newest principal-authored frozen brief.
   * Optional, defaulting to `null` (skip the binding) when omitted — every
   * existing caller that predates this field is unaffected, the same
   * optional-with-fallback shape `patchIdOf`/`policy` already use above.
   * `null` (explicit, or via omission) means no frozen brief is resolvable
   * for this PR — nothing to bind against, so every verdict passes this
   * check unconditionally, the same "skip" meaning `objectivesVersion: null`
   * already carries.
   */
  briefHash?: string | null
  /**
   * The base commit the PR's candidate is judged against at evaluation time
   * (O1) — resolved by the caller (never
   * here; this stays pure) from the PR's base branch tip, the same
   * `origin/<baseRefName>` `patchIdOf` already diffs against. Optional,
   * defaulting to `null` (skip the base binding) when omitted — every existing
   * caller and every fixture that predates base identity is unaffected, the
   * same optional-with-fallback shape `patchIdOf`/`policy`/`briefHash` already
   * use. Bounded, not an always-checked equality: a base move under an exact
   * head sha invalidates, while a proven patch-identity rebase tolerates it —
   * see `compareManifest`'s own base rule.
   */
  baseSha?: string | null
}

/**
 * Branch names are contributor-controlled metadata, so none can exempt an
 * authority check. The former `plan/*` exemption assumed those branches
 * contained topology docs only; a contributor could put code on a branch
 * with that prefix and make the adapter exit before it fetched the PR. Keep
 * this exported predicate for API compatibility, but fail closed for every
 * branch. A future plan-only exemption would need server-derived changed-file
 * validation, not a name prefix.
 */
export function isReviewGateExemptBranch(_branch: string): boolean {
  return false
}

/**
 * `pass` when either (a) `vinaya/waiver:review` is present and actor-verified against
 * `PRINCIPAL_ALLOWLIST`, or (b) both verdicts are clean AND bound — code-reviewer
 * `APPROVE` (not `REQUEST_CHANGES`, not missing, not unclear) covering the PR's
 * current `headSha` — by that sha, or by an equal patch identity when
 * `patchIdOf` is supplied — and security-review `PASS` (not `FAIL`, not
 * missing, not unclear) covering it too, both also bound to the current
 * objectives version and the current newest ruling ordinal. `fail`
 * otherwise, naming exactly which verdict(s) are not clean or not bound to
 * the current head.
 *
 * Reviews and nothing else. No other check's result, and no Test Plan
 * tick-state, is an input here or may become one: every merge condition is
 * its own independent check, so that all green means mergeable, and a gate
 * that re-reported a sibling check's red answered a question it does not
 * own. Adding such an input back is a deliberate regression a dedicated
 * architecture test refuses.
 *
 * A verdict's own `VERDICT:` text is not, by itself, sufficient for "clean":
 * the comment's own FINDINGS block
 * is re-evaluated against `input.policy` (`evaluateCodeReview`/
 * `evaluateSecurityReview`, `@attalabs/aeg-core`'s pure evaluator), and an
 * `APPROVE`/`PASS` beside a finding at or above the threshold reads as not
 * clean here regardless — a reviewer's own clean-sounding verdict never
 * overrides the evaluator.
 */
export function checkReviewGate(input: ReviewGateInput): ReviewGateResult {
  const principalAllowlist = input.principalAllowlist ?? PRINCIPAL_ALLOWLIST
  const waived = isWaiverLabelActorVerified({
    label: WAIVER_LABEL_REVIEW,
    labels: input.labels,
    labelActor: input.waiverLabelActor,
    principalAllowlist
  })
  if (waived) {
    return {
      verdict: 'pass',
      reason: `\`${WAIVER_LABEL_REVIEW}\` label is actor-verified — review requirement waived for this PR.`,
      waived: true
    }
  }

  // Verdict-AUTHOR verification (a security finding): on a public
  // repo any GitHub account can post a `VERDICT: APPROVE`-shaped comment, and
  // most-recent-clear-hit-wins extraction would let a forged later APPROVE
  // override a real earlier REQUEST CHANGES. Only comments whose author is on
  // the same `PRINCIPAL_ALLOWLIST` the waiver's actor check already trusts
  // participate in verdict extraction; everything else — unknown authors and
  // unresolvable (`null`) ones alike — is IGNORED, never fatal, so a drive-by
  // comment cannot brick evaluation, only fail to count. Dispatched reviewer
  // agents post under the principal's own `gh` identity, so the legitimate
  // flow is unchanged.
  const verified = input.comments.filter((c) => isPrincipal(c.author, principalAllowlist))
  // Count only VERDICT-shaped ignored comments — deployment bots and ordinary
  // chat are also non-allowlisted, and counting them would imply forgery
  // where there is only noise (a review finding).
  const ignoredCount = input.comments.filter(
    (c) => !isPrincipal(c.author, principalAllowlist) && c.body.includes('VERDICT')
  ).length
  const verifiedBodies = verified.map((c) => c.body)

  const codeReview = extractCodeReviewVerdict(verifiedBodies)
  const security = extractSecurityReviewVerdict(verifiedBodies)
  const policy = input.policy ?? DEFAULT_REVIEW_POLICY
  // O3: a reviewer's own APPROVE/PASS never overrides the evaluator — clean
  // requires BOTH a clean text value AND the evaluator finding nothing at or
  // above policy in the comment's own FINDINGS block. A finding the text
  // claims to be clean beside is read as not clean here, regardless of what
  // the VERDICT: line says.
  //
  // `findingSeverities` is a bare regex extraction over a hand-typed
  // principal comment (`verdict-extraction.ts`'s `FINDING_SEVERITY_LINE`),
  // not validated output — `evaluateReviewFindings` throws on any token
  // outside the role's own scale. Every other refusal in this function
  // returns a named `fail` result; an uncaught throw here would crash the
  // check-run instead, on nothing worse than a typo in a manually-posted
  // comment. Caught and failed closed the same way.
  //
  // O1/O4: only CONSEQUENTIAL findings are evaluated — a finding the reviewer
  // marked `resolved` keeps its severity in the record but no longer blocks,
  // the SAME `consequentialFindings` filter `deriveCodeReviewVerdict` applies
  // before it derives APPROVE/PASS, so an APPROVE whose only blocking findings
  // are `resolved` passes the gate exactly as it made derivation approve. A
  // finding at or above the threshold in any other state — `open`,
  // `fix-claimed`, `reproduced`, or no state token — is untouched by the
  // filter and still blocks (O2).
  let codeReviewPolicyEvaluation: ReturnType<typeof evaluateCodeReview>
  let securityPolicyEvaluation: ReturnType<typeof evaluateSecurityReview>
  try {
    codeReviewPolicyEvaluation = evaluateCodeReview(consequentialFindings(codeReview.findingSeverities), policy)
    securityPolicyEvaluation = evaluateSecurityReview(consequentialFindings(security.findingSeverities), policy)
  } catch (err) {
    return {
      verdict: 'fail',
      reason: `a verdict comment carries a finding severity this repository's policy does not recognize: ${err instanceof Error ? err.message : String(err)}`,
      waived: false
    }
  }
  const codeReviewTextClean = codeReview.value === 'APPROVE'
  const securityTextClean = security.value === 'PASS'
  const codeReviewPolicyClean = codeReviewPolicyEvaluation.outcome === 'clean'
  const securityPolicyClean = securityPolicyEvaluation.outcome === 'clean'
  const codeReviewClean = codeReviewTextClean && codeReviewPolicyClean
  const securityClean = securityTextClean && securityPolicyClean
  // task 4: ONE comparison — the same `compareManifest` the
  // loop's own publication self-check calls — behind every binding below,
  // rather than four separate hand-rolled predicates. `current` is this
  // evaluation's own manifest; each verdict's own echoed fields (read by
  // `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` above) are
  // compared against it, never trusted as provenance on their own. Built
  // directly (not via `buildReviewInputManifest`, which hashes a caller
  // brief string) since the caller already resolved `briefHash` itself and
  // this module stays pure — no hashing of forge content here.
  const currentManifest: ReviewInputManifest = {
    headSha: input.headSha,
    baseSha: input.baseSha ?? null,
    briefHash: input.briefHash ?? null,
    objectivesVersion: input.objectivesVersion,
    rulingOrdinal: input.rulingOrdinal,
    policyDigest: computePolicyDigest(policy)
  }
  const codeReviewEchoed: EchoedManifest = {
    headSha: codeReview.headSha,
    baseSha: codeReview.baseSha,
    briefHash: codeReview.briefHash,
    objectivesVersion: codeReview.objectivesVersion,
    rulingOrdinal: codeReview.rulingOrdinal,
    policyDigest: codeReview.policyDigest
  }
  const securityEchoed: EchoedManifest = {
    headSha: security.headSha,
    baseSha: security.baseSha,
    briefHash: security.briefHash,
    objectivesVersion: security.objectivesVersion,
    rulingOrdinal: security.rulingOrdinal,
    policyDigest: security.policyDigest
  }
  const codeReviewBinding = compareManifest(codeReviewEchoed, currentManifest, input.patchIdOf)
  const securityBinding = compareManifest(securityEchoed, currentManifest, input.patchIdOf)
  const codeReviewBound = codeReviewBinding.head
  const securityBound = securityBinding.head
  const codeReviewObjectivesBound = codeReviewBinding.objectivesVersion
  const securityObjectivesBound = securityBinding.objectivesVersion
  const codeReviewRulingsBound = codeReviewBinding.rulingOrdinal
  const securityRulingsBound = securityBinding.rulingOrdinal

  if (codeReviewClean && codeReviewBinding.bound && securityClean && securityBinding.bound) {
    return {
      verdict: 'pass',
      reason: `code-reviewer verdict is a clean APPROVE and security-review verdict is a clean PASS, both covering head ${input.headSha}.`,
      waived: false
    }
  }

  const problems: string[] = []
  if (!codeReviewTextClean) {
    problems.push(`code-reviewer verdict is not a clean APPROVE (found: ${codeReview.value})`)
  } else if (!codeReviewPolicyClean) {
    problems.push(
      `code-reviewer verdict says APPROVE but carries a finding (${codeReviewPolicyEvaluation.blockingFindings.map((f) => f.severity).join(', ')}) at or above this repository's code-review policy threshold (${policy.codeReviewThreshold}) — a reviewer's own APPROVE never overrides policy`
    )
  } else if (!codeReviewBound) {
    problems.push(
      `the newest code-review verdict covers ${codeReview.headSha ?? 'no recorded commit'}, head is ${input.headSha}`
    )
  } else if (!codeReviewBinding.base) {
    problems.push(
      `the newest code-review verdict was cast against base ${codeReview.baseSha ?? 'no recorded base'}, the PR's base is now ${currentManifest.baseSha ?? 'unresolved'} (a base-only change under an unchanged candidate — same patch text on a new base is not automatically equivalent)`
    )
  } else if (!codeReviewObjectivesBound) {
    problems.push(
      `the newest code-review verdict was cast against objectives version ${codeReview.objectivesVersion ?? 'none'}, the Issue's list is now ${input.objectivesVersion}`
    )
  } else if (!codeReviewRulingsBound) {
    problems.push(
      `the newest code-review verdict was cast against ruling ordinal ${codeReview.rulingOrdinal ?? 'none'}, a newer ruling (ruling ${input.rulingOrdinal}) is now posted on this PR`
    )
  } else if (!codeReviewBinding.briefHash) {
    problems.push(
      `the newest code-review verdict was cast against brief hash ${codeReview.briefHash ?? 'none'}, the frozen brief's current hash is ${currentManifest.briefHash ?? 'none'}`
    )
  } else if (!codeReviewBinding.policyDigest) {
    problems.push(
      `the newest code-review verdict was cast against review policy digest ${codeReview.policyDigest ?? 'none'}, this repository's current policy digest is ${currentManifest.policyDigest}`
    )
  }
  if (!securityTextClean) {
    problems.push(`security-review verdict is not a clean PASS (found: ${security.value})`)
  } else if (!securityPolicyClean) {
    problems.push(
      `security-review verdict says PASS but carries a finding (${securityPolicyEvaluation.blockingFindings.map((f) => f.severity).join(', ')}) at or above this repository's security policy threshold (${policy.securityThreshold}) — a reviewer's own PASS never overrides policy`
    )
  } else if (!securityBound) {
    problems.push(
      `the newest security-review verdict covers ${security.headSha ?? 'no recorded commit'}, head is ${input.headSha}`
    )
  } else if (!securityBinding.base) {
    problems.push(
      `the newest security-review verdict was cast against base ${security.baseSha ?? 'no recorded base'}, the PR's base is now ${currentManifest.baseSha ?? 'unresolved'} (a base-only change under an unchanged candidate — same patch text on a new base is not automatically equivalent)`
    )
  } else if (!securityObjectivesBound) {
    problems.push(
      `the newest security-review verdict was cast against objectives version ${security.objectivesVersion ?? 'none'}, the Issue's list is now ${input.objectivesVersion}`
    )
  } else if (!securityRulingsBound) {
    problems.push(
      `the newest security-review verdict was cast against ruling ordinal ${security.rulingOrdinal ?? 'none'}, a newer ruling (ruling ${input.rulingOrdinal}) is now posted on this PR`
    )
  } else if (!securityBinding.briefHash) {
    problems.push(
      `the newest security-review verdict was cast against brief hash ${security.briefHash ?? 'none'}, the frozen brief's current hash is ${currentManifest.briefHash ?? 'none'}`
    )
  } else if (!securityBinding.policyDigest) {
    problems.push(
      `the newest security-review verdict was cast against review policy digest ${security.policyDigest ?? 'none'}, this repository's current policy digest is ${currentManifest.policyDigest}`
    )
  }
  const ignoredNote =
    ignoredCount > 0
      ? ` ${ignoredCount} verdict-shaped comment(s) from authors outside the principal allowlist were ignored.`
      : ''

  return {
    verdict: 'fail',
    reason: `${problems.join('; ')}. A principal can apply an actor-verified \`${WAIVER_LABEL_REVIEW}\` label to skip this requirement, or post the missing/clean verdict comment(s).${ignoredNote}`,
    waived: false
  }
}

/**
 * Exported so a caller can cheaply pre-check the branch BEFORE paying for
 * whatever it takes to resolve `expectedAuthor` — resolving that value is a
 * network round-trip (`resolveReleaseActor(loadTrustAnchorConfig())`) that
 * must not run on every ordinary PR just because it is one of three
 * arguments to `isChangesetsReleasePr`. Found live in code review:
 * evaluating it inline as a function argument runs it unconditionally,
 * regardless of branch, since JS evaluates arguments eagerly.
 */
export const CHANGESET_RELEASE_BRANCH = 'changeset-release/main'

/**
 * The stock Changesets flow's default identity — a release PR opened by
 * `changesets/action` using the ambient `GITHUB_TOKEN` shows this as its
 * author. Only a SANE DEFAULT for adopters who haven't configured
 * `releaseActor` — never assume it matches any specific repo's real setup.
 * A repo that opens release PRs with a custom PAT (this repo's own
 * `RELEASE_TOKEN`, `.github/workflows/release.yml`) has a DIFFERENT real PR
 * author (the token's owner) and must set `releaseActor` in its
 * `vinaya.config.json`.
 */
export const DEFAULT_RELEASE_ACTOR = 'github-actions[bot]'

/**
 * True only for the Changesets release PR. `branch` and `author` must both
 * match — `branch` alone is not a trust boundary, an attacker can push a
 * branch literally called `changeset-release/main`. `expectedAuthor` is
 * caller-resolved, never hardcoded here — this ships in the published
 * `@attalabs/vinaya` package, and hardcoding any one identity would be
 * correct for at most one adopter's release-token setup. Callers resolve it
 * via `resolveReleaseActor(loadTrustAnchorConfig())`, falling back to
 * `DEFAULT_RELEASE_ACTOR`.
 *
 * This predicate is pure and trust-agnostic about ITS OWN inputs — the
 * caller is entirely responsible for where `branch`/`author` come from.
 * `check-body-bare-digits.ts` is the one caller, and only reachable in
 * production from `vinaya-body-checks.yml`'s `pull_request_target` job:
 * `branch`/`author` there come from a live `gh pr view <PR_NUMBER>` fetch,
 * with `PR_NUMBER` itself sourced from `github.event.pull_request.number` —
 * an expression evaluated from the workflow file on the DEFAULT BRANCH, a
 * pull request cannot edit that file to substitute a different literal
 * (the same `pull_request_target` boundary `vinaya-review.yml` already
 * uses). Found live: the identical exemption on a plain
 * `pull_request` trigger let an attacker redirect `PR_NUMBER`/`BRANCH` to
 * any already-approved PR by the configured release actor — verified no
 * env-var or git-state signal inside that trigger type is a safe anchor,
 * which is why this predicate never runs there again.
 */
export function isChangesetsReleasePr(branch: string, author: string | null, expectedAuthor: string): boolean {
  return branch === CHANGESET_RELEASE_BRANCH && author === expectedAuthor
}
