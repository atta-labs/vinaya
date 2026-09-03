/**
 * Required pre-merge review gate (aeg-review-gate-v1 task 1, #474). Blocks a
 * PR from merging unless a clean code-reviewer `APPROVE` verdict
 * AND a clean security-review `PASS` verdict both exist on the PR — the same
 * `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` detection
 * (`verdict-extraction.ts`) the post-merge Archivist automation already runs,
 * now gated pre-merge and blocking instead of post-merge and advisory-only.
 *
 * Verdict comments are ONLY counted when their author is on the same
 * `PRINCIPAL_ALLOWLIST` the waiver actor-check trusts (security finding,
 * PR #806): body-shape alone is never sufficient on a public repo. Unverified
 * comments are ignored, not fatal.
 *
 * A verified `vinaya/waiver:review` label (the exact actor-verification pattern,
 * `isWaiverLabelActorVerified` reused directly and parameterized by label —
 * see `waiver-label.ts`) lets a principal explicitly skip the requirement for
 * one PR. Label presence alone is never sufficient — only an actor-verified
 * label waives the gate, mirroring exactly.
 *
 * Reviewed-commit binding (#73, a duplicate of #71 closes this one). A clean
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
 * Pure — no `fs`, no `fetch`, no `process.env`. The CLI shim
 * (`bin/verify-review-gate.ts`) resolves the PR's comments/labels/label-actor/
 * head sha via `gh` and calls `checkReviewGate`.
 */

import { isPrincipal, isWaiverLabelActorVerified, PRINCIPAL_ALLOWLIST, WAIVER_LABEL_REVIEW } from './waiver-label'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from './verdict-extraction'

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

export type MechanicalCheckStatus = {
  /** The check-run's display name, as GitHub reports it (`gh pr checks`' own `name` field). */
  name: string
  /** GitHub's own coalesced status vocabulary for this check-run — forwarded verbatim from `gh pr checks --json name,bucket`'s `bucket` field (e.g. "pass", "fail", "pending", "skipping", "cancel"). Not re-mapped to a smaller enum here — that would be a second copy of a vocabulary `gh` already owns. */
  bucket: string
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
   * PR-editable YAML could steer (#73). REQUIRED, not optional: an omitted
   * head would have to mean either skip-the-binding-check (fail-open, the
   * exact defect this field exists to close) or unconditional-fail, and a
   * required field makes that choice a compile error instead of a runtime
   * default. Every verdict must cover this value to count as clean.
   */
  headSha: string
  /**
   * Every check-run reported for the PR's current head, EXCLUDING this
   * repo's own review-gate check-run (the caller filters that out before
   * calling in — see check-review-gate.ts's own comment for why the
   * exclusion must not live here). An empty array means no mechanical
   * check-run has reported yet, which does NOT count as clean — there is
   * no proof to point to, not an implicit pass.
   */
  mechanicalChecks: MechanicalCheckStatus[]
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
   * at the new head — which this gate already requires green — is the guard
   * for it.
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
 * True when `extraction.headSha` covers `headSha` — an exact match, or
 * `headSha` starting with `extraction.headSha` (the abbreviated-sha case:
 * a verdict may bind against a 7-char prefix, and `headSha` itself is always
 * the full 40-char form GitHub's API returns). `false` when the extraction
 * carries no `headSha` at all (no `Judged head:` line was found) — an
 * unbound verdict never counts as covering anything.
 */
function isBoundToHead(extraction: { headSha: string | null }, headSha: string): boolean {
  if (!extraction.headSha) return false
  return headSha.toLowerCase().startsWith(extraction.headSha.toLowerCase())
}

/**
 * True when the judged head and the current head carry the SAME patch — the
 * verdict was cast on this exact set of changes, whatever sha now addresses
 * it. Composed BESIDE `isBoundToHead`, never in place of it: sha binding
 * still counts on its own, and this only widens what else counts.
 *
 * Fails closed on every uncertainty. `null` on either side is "git could not
 * answer", not "they match" — a force-push that makes the judged head
 * unreachable resolves to `null` and the verdict correctly stops counting.
 */
function isBoundByPatchIdentity(
  extraction: { headSha: string | null },
  headSha: string,
  patchIdOf?: (sha: string) => string | null
): boolean {
  if (patchIdOf === undefined || !extraction.headSha) return false
  const judged = patchIdOf(extraction.headSha)
  const current = patchIdOf(headSha)
  if (judged === null || current === null) return false
  return judged === current
}

/** A verdict covers the current head when its sha binds it, or its patch identity does. */
function isBoundToPatch(
  extraction: { headSha: string | null },
  headSha: string,
  patchIdOf?: (sha: string) => string | null
): boolean {
  return isBoundToHead(extraction, headSha) || isBoundByPatchIdentity(extraction, headSha, patchIdOf)
}

/**
 * `pass` when either (a) `vinaya/waiver:review` is present and actor-verified against
 * `PRINCIPAL_ALLOWLIST`, or (b) both verdicts are clean AND bound — code-reviewer
 * `APPROVE` (not `REQUEST_CHANGES`, not missing, not unclear) covering the PR's
 * current `headSha` — by that sha, or by an equal patch identity when
 * `patchIdOf` is supplied — and security-review `PASS` (not `FAIL`, not
 * missing, not unclear) covering it too — AND every reported mechanical check-run for that
 * same head is green (`mechanicalChecks` non-empty and every entry's `bucket`
 * is `"pass"`). `fail` otherwise, naming exactly which verdict(s) are not
 * clean, not bound to the current head, which mechanical check(s) are not
 * green, or that none have reported at all.
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

  const mechanicalChecksClean =
    input.mechanicalChecks.length > 0 && input.mechanicalChecks.every((c) => c.bucket === 'pass')

  // Verdict-AUTHOR verification (security finding on PR #806): on a public
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
  // where there is only noise (review finding, PR #806).
  const ignoredCount = input.comments.filter(
    (c) => !isPrincipal(c.author, principalAllowlist) && c.body.includes('VERDICT')
  ).length
  const verifiedBodies = verified.map((c) => c.body)

  const codeReview = extractCodeReviewVerdict(verifiedBodies)
  const security = extractSecurityReviewVerdict(verifiedBodies)
  const codeReviewClean = codeReview.value === 'APPROVE'
  const securityClean = security.value === 'PASS'
  const codeReviewBound = isBoundToPatch(codeReview, input.headSha, input.patchIdOf)
  const securityBound = isBoundToPatch(security, input.headSha, input.patchIdOf)

  if (codeReviewClean && codeReviewBound && securityClean && securityBound && mechanicalChecksClean) {
    return {
      verdict: 'pass',
      reason: `code-reviewer verdict is a clean APPROVE and security-review verdict is a clean PASS, both covering head ${input.headSha}, and every reported mechanical check is green.`,
      waived: false
    }
  }

  const problems: string[] = []
  if (!codeReviewClean) {
    problems.push(`code-reviewer verdict is not a clean APPROVE (found: ${codeReview.value})`)
  } else if (!codeReviewBound) {
    problems.push(
      `the newest code-review verdict covers ${codeReview.headSha ?? 'no recorded commit'}, head is ${input.headSha}`
    )
  }
  if (!securityClean) {
    problems.push(`security-review verdict is not a clean PASS (found: ${security.value})`)
  } else if (!securityBound) {
    problems.push(
      `the newest security-review verdict covers ${security.headSha ?? 'no recorded commit'}, head is ${input.headSha}`
    )
  }
  if (!mechanicalChecksClean) {
    problems.push(
      input.mechanicalChecks.length === 0
        ? 'no mechanical checks have reported for this head yet'
        : `mechanical check(s) not green: ${input.mechanicalChecks
            .filter((c) => c.bucket !== 'pass')
            .map((c) => `${c.name} (${c.bucket})`)
            .join(', ')}`
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
 * arguments to `isChangesetsReleasePr`. Found live (code review, PR #169):
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
 * uses). Found live (round 5, PR #165): the identical exemption on a plain
 * `pull_request` trigger let an attacker redirect `PR_NUMBER`/`BRANCH` to
 * any already-approved PR by the configured release actor — verified no
 * env-var or git-state signal inside that trigger type is a safe anchor,
 * which is why this predicate never runs there again.
 */
export function isChangesetsReleasePr(branch: string, author: string | null, expectedAuthor: string): boolean {
  return branch === CHANGESET_RELEASE_BRANCH && author === expectedAuthor
}
