import { describe, expect, it } from 'vitest'
import { checkReviewGate, isChangesetsReleasePr, isReviewGateExemptBranch } from './review-gate'
import { policyDigest } from './review-input-manifest'
import { DEFAULT_REVIEW_POLICY } from './review-policy'

import type { MechanicalCheckStatus, ReviewGateComment } from './review-gate'

/** A single green check-run — the default "mechanical checks are clean" fixture for tests that are about verdict logic, not mechanical-check logic. */
const CLEAN_CHECKS: MechanicalCheckStatus[] = [{ name: 'Vinaya CI', bucket: 'pass' }]

/**
 * The digest `checkReviewGate` resolves whenever a test omits its own
 * `policy` field (it defaults to `DEFAULT_REVIEW_POLICY`) — every shared
 * "clean" comment fixture in this file that isn't itself testing the
 * policy-digest binding renders this line so it satisfies that binding too
 * (`#478` round 4, security MEDIUM: a `Policy digest:`-less comment no
 * longer binds unconditionally).
 */
const DEFAULT_POLICY_DIGEST = policyDigest(DEFAULT_REVIEW_POLICY)

/** Principal-authored comment — the allowlisted author every legitimate verdict flows through. */
const principal = (body: string): ReviewGateComment => ({ body, author: 'daniboomerang' })
/** Forged comment — an arbitrary GitHub account (security finding, PR #806). */
const forged = (body: string): ReviewGateComment => ({ body, author: 'drive-by-account' })

/** The PR's current head throughout this file's main test block, unless a test says otherwise. */
const HEAD_SHA = '8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f'

// Judged head: sits on line 3, matching the real render shape
// (`review-post.ts`'s templates put `VERDICT:`/`Judged head:` on lines 1/3,
// never later) — the extractors now read the markers from a comment's
// first five lines only (round-4 ruling, `#392`, widened by `#412`). These fixtures test
// decoration, not marker position, so the decoration moves after the head.
const APPROVE_COMMENT = principal(
  `VERDICT: APPROVE\n\nJudged head: ${HEAD_SHA}\n\nBRIEF CONFORMANCE: clean. Looks good.\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`
)
const PASS_COMMENT = principal(
  `VERDICT: PASS\n\nJudged head: ${HEAD_SHA}\n\nFINDINGS: none.\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`
)
const REQUEST_CHANGES_COMMENT = principal(`VERDICT: REQUEST_CHANGES\n\nJudged head: ${HEAD_SHA}\n\nsee inline notes.`)
const FAIL_COMMENT = principal(`VERDICT: FAIL\n\nJudged head: ${HEAD_SHA}\n\nhardcoded credential found.`)

describe('checkReviewGate', () => {
  it('passes when both verdicts are clean (APPROVE + PASS) and both cover the current head', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
    expect(result.waived).toBe(false)
  })

  it('fails when no review comments exist at all (the historical-PR case, e.g. PR #435)', () => {
    const result = checkReviewGate({
      comments: [],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('code-reviewer verdict is not a clean APPROVE')
    expect(result.reason).toContain('security-review verdict is not a clean PASS')
  })

  it('fails when code review is REQUEST_CHANGES even though security is PASS', () => {
    const result = checkReviewGate({
      comments: [REQUEST_CHANGES_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('code-reviewer verdict is not a clean APPROVE (found: REQUEST CHANGES)')
  })

  it('fails when security is FAIL even though code review is APPROVE', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, FAIL_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('security-review verdict is not a clean PASS (found: FAIL)')
  })

  it('fails when only one of the two verdicts is present', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('security-review verdict is not a clean PASS')
  })

  it('passes when both verdicts are clean, regardless of comment order', () => {
    const result = checkReviewGate({
      comments: [PASS_COMMENT, APPROVE_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })

  describe('reviewed-commit binding (#73, a duplicate of #71 closes this one)', () => {
    it('fails when a clean APPROVE names a superseded head — the exact attalabs#664 failure mode', () => {
      const staleSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const result = checkReviewGate({
        comments: [principal(`VERDICT: APPROVE\n\nJudged head: ${staleSha}`), PASS_COMMENT],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.reason).toContain(`the newest code-review verdict covers ${staleSha}, head is ${HEAD_SHA}`)
    })

    it('fails when a clean PASS carries no reviewed-commit binding at all (pre-fix hand-typed prose, no Judged head: line)', () => {
      const result = checkReviewGate({
        comments: [APPROVE_COMMENT, principal(`VERDICT: PASS\n\nreviewed at head ${HEAD_SHA.slice(0, 8)}.`)],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.reason).toContain(
        `the newest security-review verdict covers no recorded commit, head is ${HEAD_SHA}`
      )
    })

    it('passes when both verdicts bind against an abbreviated form of the current head', () => {
      const shortSha = HEAD_SHA.slice(0, 7)
      const result = checkReviewGate({
        comments: [
          principal(`VERDICT: APPROVE\n\nJudged head: ${shortSha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`),
          principal(`VERDICT: PASS\n\nJudged head: ${shortSha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`)
        ],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('pass')
    })

    it('a push that changes the head reopens a previously-clean gate — same comments, new headSha', () => {
      const newHeadAfterPush = 'ffffffffffffffffffffffffffffffffffffff'
      const result = checkReviewGate({
        comments: [APPROVE_COMMENT, PASS_COMMENT],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: CLEAN_CHECKS,
        headSha: newHeadAfterPush,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.reason).toContain(`the newest code-review verdict covers ${HEAD_SHA}, head is ${newHeadAfterPush}`)
      expect(result.reason).toContain(
        `the newest security-review verdict covers ${HEAD_SHA}, head is ${newHeadAfterPush}`
      )
    })

    it('a re-cast verdict at the new head clears the gate again', () => {
      const newHeadAfterPush = 'ffffffffffffffffffffffffffffffffffffff'
      const result = checkReviewGate({
        comments: [
          APPROVE_COMMENT,
          PASS_COMMENT,
          principal(
            `VERDICT: APPROVE\n\nJudged head: ${newHeadAfterPush}\n\nsupersedes my prior pass.\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`
          ),
          principal(
            `VERDICT: PASS\n\nJudged head: ${newHeadAfterPush}\n\nsupersedes my prior pass.\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`
          )
        ],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: CLEAN_CHECKS,
        headSha: newHeadAfterPush,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('pass')
    })
  })

  describe('vinaya/waiver:review actor verification', () => {
    it('label absent → gate still evaluates verdicts normally (fails on empty comments)', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/tier:1'],
        waiverLabelActor: 'daniboomerang',
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.waived).toBe(false)
    })

    it('label present, actor not in allowlist → ignored, gate still fails on missing verdicts', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/waiver:review'],
        waiverLabelActor: 'some-agent-bot',
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.waived).toBe(false)
    })

    it('label present, actor null (no labeling event found) → ignored, gate fails', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/waiver:review'],
        waiverLabelActor: null,
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.waived).toBe(false)
    })

    it('label present, actor in allowlist → passes without any review comments', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/waiver:review'],
        waiverLabelActor: 'daniboomerang',
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('pass')
      expect(result.waived).toBe(true)
    })

    it('a different label (vinaya/waiver:docs) applied by the principal does not waive the review gate', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/waiver:docs'],
        waiverLabelActor: 'daniboomerang',
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.waived).toBe(false)
    })
  })

  describe('mechanical checks (review-mechanical-gate-v1 task 2, #337)', () => {
    it('passes when mechanical checks are all green and both verdicts are clean and bound', () => {
      const result = checkReviewGate({
        comments: [APPROVE_COMMENT, PASS_COMMENT],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: [
          { name: 'Vinaya CI', bucket: 'pass' },
          { name: 'vinaya check --all --diff-only', bucket: 'pass' }
        ],
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('pass')
    })

    it('fails, naming the red check, when a mechanical check is not green even though both verdicts are clean and bound', () => {
      const result = checkReviewGate({
        comments: [APPROVE_COMMENT, PASS_COMMENT],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: [
          { name: 'Vinaya CI', bucket: 'fail' },
          { name: 'vinaya check --all --diff-only', bucket: 'pass' }
        ],
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.reason).toContain('mechanical check(s) not green: Vinaya CI (fail)')
    })

    it('fails, naming that none have reported, when zero mechanical checks are reported', () => {
      const result = checkReviewGate({
        comments: [APPROVE_COMMENT, PASS_COMMENT],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: [],
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.reason).toContain('no mechanical checks have reported for this head yet')
    })

    it('the waiver label still short-circuits to pass regardless of mechanical-check state', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/waiver:review'],
        waiverLabelActor: 'daniboomerang',
        mechanicalChecks: [],
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('pass')
      expect(result.waived).toBe(true)
    })

    // Issue #402 O4: a job whose own `if:` is false for the current event
    // still reports a `skipped` (bucket `skipping`, same as GitHub's
    // `neutral` conclusion) check-run — `vinaya-review.yml`'s old
    // `retrigger-on-ci-green` job did this on every ordinary
    // `pull_request_target` run, and blocked every PR until this fix.
    it('a skipping/neutral mechanical check is ignored, never treated as a failure', () => {
      const result = checkReviewGate({
        comments: [APPROVE_COMMENT, PASS_COMMENT],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: [
          { name: 'Vinaya CI', bucket: 'pass' },
          { name: 'vinaya review gate (retrigger on CI green)', bucket: 'skipping' },
          { name: 'some other neutral job', bucket: 'neutral' }
        ],
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('pass')
    })

    it('a head reporting only skipping/neutral checks reads as none reported, not as clean', () => {
      const result = checkReviewGate({
        comments: [APPROVE_COMMENT, PASS_COMMENT],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: [{ name: 'vinaya review gate (retrigger on CI green)', bucket: 'skipping' }],
        headSha: HEAD_SHA,
        objectivesVersion: null,
        rulingOrdinal: 0
      })
      expect(result.verdict).toBe('fail')
      expect(result.reason).toContain('no mechanical checks have reported for this head yet')
    })
  })
})

describe('isReviewGateExemptBranch', () => {
  it('does NOT trust a plan prefix — a contributor controls the branch name and may put code on it', () => {
    expect(isReviewGateExemptBranch('plan/vinaya-v1')).toBe(false)
  })

  it('does NOT exempt a fix branch — fix/* carries real code (the gap this closes)', () => {
    expect(isReviewGateExemptBranch('fix/some-bug')).toBe(false)
  })

  it('does NOT exempt a task branch — held to the gate as before', () => {
    expect(isReviewGateExemptBranch('task/vada-production-v1/10')).toBe(false)
  })

  it('does NOT exempt an unrecognized branch — fail closed, not fail open', () => {
    expect(isReviewGateExemptBranch('some-random-branch')).toBe(false)
    expect(isReviewGateExemptBranch('')).toBe(false)
  })
})

describe('checkReviewGate — verdict-author verification (security finding, PR #806)', () => {
  it('ignores a forged APPROVE + PASS pair from a non-allowlisted author (gate stays failed)', () => {
    const result = checkReviewGate({
      comments: [
        forged(`VERDICT: APPROVE\n\nlooks great!\n\nJudged head: ${HEAD_SHA}`),
        forged(`VERDICT: PASS\n\nno findings.\n\nJudged head: ${HEAD_SHA}`)
      ],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      '2 verdict-shaped comment(s) from authors outside the principal allowlist were ignored'
    )
  })

  it('a forged later APPROVE does not override a real REQUEST_CHANGES', () => {
    const result = checkReviewGate({
      comments: [
        REQUEST_CHANGES_COMMENT,
        PASS_COMMENT,
        forged(`VERDICT: APPROVE\n\noverriding!\n\nJudged head: ${HEAD_SHA}`)
      ],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('code-reviewer verdict is not a clean APPROVE')
  })

  it('a null-author comment is ignored, not fatal', () => {
    const result = checkReviewGate({
      comments: [{ body: `VERDICT: APPROVE\n\nJudged head: ${HEAD_SHA}`, author: null }, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
  })

  it('non-verdict bot chatter is not counted as ignored', () => {
    const result = checkReviewGate({
      comments: [
        { body: 'Deployment failed for project herald-ai', author: 'vercel[bot]' },
        REQUEST_CHANGES_COMMENT,
        PASS_COMMENT
      ],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).not.toContain('were ignored')
  })

  it('verified verdicts still pass with forged noise present', () => {
    const result = checkReviewGate({
      comments: [forged(`VERDICT: FAIL\n\nchaos\n\nJudged head: ${HEAD_SHA}`), APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })
})

describe('checkReviewGate — configurable principalAllowlist (adopter-repo fix)', () => {
  const adopterApprove = (author: string) => ({
    body: `VERDICT: APPROVE\n\nJudged head: ${HEAD_SHA}\n\nclean.\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`,
    author
  })
  const adopterPass = (author: string) => ({
    body: `VERDICT: PASS\n\nJudged head: ${HEAD_SHA}\n\nno findings.\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`,
    author
  })

  it('a caller with no principalAllowlist keeps the default PRINCIPAL_ALLOWLIST behavior (backward compatible)', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('someone-else'), adopterPass('someone-else')],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
      // no principalAllowlist passed
    })
    expect(result.verdict).toBe('fail') // 'someone-else' isn't the hardcoded default
  })

  it('an overridden principalAllowlist counts a verdict from an adopter-trusted author', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('someone-else'), adopterPass('someone-else')],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      principalAllowlist: ['someone-else'],
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })

  it('matches logins case-insensitively, as GitHub itself does — a config that wrote "Alice" still counts alice’s verdicts', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('alice'), adopterPass('ALICE')],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      principalAllowlist: ['Alice'],
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })

  it('case-insensitivity does not widen trust — a genuinely different login is still ignored', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('alice-bot'), adopterPass('alice-bot')],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      principalAllowlist: ['Alice'],
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
  })

  it('an overridden principalAllowlist is a true REPLACEMENT, not additive — the hardcoded default author no longer counts once overridden', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('daniboomerang'), adopterPass('daniboomerang')],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      principalAllowlist: ['someone-else'], // daniboomerang deliberately excluded
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      '2 verdict-shaped comment(s) from authors outside the principal allowlist were ignored'
    )
  })

  it('an EMPTY principalAllowlist trusts nobody — every verdict is ignored and the gate fails closed', () => {
    // The shape an adopter hits when `principals` resolves to an empty list.
    // Fail-closed is the only safe reading: an empty trust anchor must not be
    // read as "trust anyone", and `isPrincipal` never matches against it.
    const result = checkReviewGate({
      comments: [adopterApprove('daniboomerang'), adopterPass('daniboomerang')],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      principalAllowlist: [],
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.waived).toBe(false)
  })

  it('an EMPTY principalAllowlist also refuses the waiver label, whoever applied it', () => {
    const result = checkReviewGate({
      comments: [],
      labels: ['vinaya/waiver:review'],
      waiverLabelActor: 'daniboomerang',
      mechanicalChecks: CLEAN_CHECKS,
      principalAllowlist: [],
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.waived).toBe(false)
  })
})

/**
 * FIXED, NOT CHARACTERIZED — `atta-labs/vinaya#73` (a duplicate, `#71`, was
 * filed first; #73 is the Issue this fix closes).
 *
 * This block used to pin the OPEN defect: `checkReviewGate` resolved verdicts
 * by recency only, with nothing in `ReviewGateInput` carrying the PR's head
 * sha, so a verdict cast against a tree that no longer existed was
 * indistinguishable from one cast against the current tree. The three cases
 * below are the same fixtures — the live instance named in this task's
 * brief, `atta-labs/attalabs#953`, whose security `PASS` named head
 * `ab0f47c0` while the PR head was `d48236d2` — now asserting the CORRECT
 * behavior: `ReviewGateInput.headSha` is required, `verdict-extraction.ts`
 * parses a same-comment `Judged head: <sha>` line, and `checkReviewGate`
 * fails a verdict that does not cover it.
 */
describe('checkReviewGate — verdicts are bound to the head they judged (#73, fixed)', () => {
  const PR_HEAD = 'd48236d2'
  const SUPERSEDED_HEAD = 'ab0f47c0'

  it('rejects a security PASS that names a superseded head (attalabs#953, corrected)', () => {
    const result = checkReviewGate({
      comments: [
        principal(`VERDICT: APPROVE\n\nJudged head: ${PR_HEAD}`),
        principal(
          `VERDICT: PASS\n\nJudged head: ${SUPERSEDED_HEAD}\n\nReviewed at head \`${SUPERSEDED_HEAD}\`.\n\nSECRETS: none found.`
        )
      ],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: PR_HEAD,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    // The verdict names a tree that is no longer the PR's head — the gate now
    // sees exactly that and refuses, naming both values.
    expect(SUPERSEDED_HEAD).not.toBe(PR_HEAD)
    expect(result.verdict).toBe('fail')
    expect(result.waived).toBe(false)
    expect(result.reason).toContain(`the newest security-review verdict covers ${SUPERSEDED_HEAD}, head is ${PR_HEAD}`)
  })

  it('rejects an APPROVE + PASS pair with no machine-readable binding, after a force-push changed the head', () => {
    // #71's reproduction, reduced: the reviewer approved head `52107b3` in
    // prose only (pre-fix convention, no `Judged head:` line); a rebase
    // replaced it with an unrelated `945b3af`; no new verdict was cast. The
    // comment stream is byte-identical to a genuinely-reviewed PR's — the fix
    // is that an unbound verdict no longer counts as covering anything.
    const newHead = '945b3af0000000000000000000000000000000'
    const result = checkReviewGate({
      comments: [
        principal('VERDICT: APPROVE\n\nreviewed at 52107b3'),
        principal('VERDICT: PASS\n\nreviewed at 52107b3')
      ],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: newHead,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(`the newest code-review verdict covers no recorded commit, head is ${newHead}`)
    expect(result.reason).toContain(`the newest security-review verdict covers no recorded commit, head is ${newHead}`)
  })

  it('an explicitly RETRACTED verdict still loses to recency (unchanged — orthogonal to binding)', () => {
    // The one thing that already worked before this fix, and still does:
    // casting a newer verdict. #71's live instance was caught only because
    // the reviewer re-checked the sha itself and posted a superseding FAIL —
    // discipline substituting for a mechanism, which the binding above now
    // makes structural instead of optional.
    const result = checkReviewGate({
      comments: [
        principal(`VERDICT: APPROVE\n\nJudged head: ${PR_HEAD}`),
        principal(`VERDICT: PASS\n\nReviewed at head \`${SUPERSEDED_HEAD}\`.\n\nJudged head: ${SUPERSEDED_HEAD}`),
        principal(
          `VERDICT: FAIL\n\nprevious PASS was against ${SUPERSEDED_HEAD}, head is now ${PR_HEAD}.\n\nJudged head: ${PR_HEAD}`
        )
      ],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: PR_HEAD,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('security-review verdict is not a clean PASS (found: FAIL)')
  })
})

describe('checkReviewGate — objectives-version binding (dev-review-loop-v1 task 2, #412, O3)', () => {
  const VERSION_A = 'a'.repeat(64)
  const VERSION_B = 'b'.repeat(64)

  const boundComment = (verdict: string, version: string) =>
    principal(
      `VERDICT: ${verdict}\n\nJudged head: ${HEAD_SHA}\n\nObjectives version: ${version}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`
    )

  it('passes when both verdicts carry the current objectives version', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', VERSION_A), boundComment('PASS', VERSION_A)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: VERSION_A,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })

  it('fails, naming both versions, when a clean code-review verdict was cast against a superseded objectives version', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', VERSION_A), boundComment('PASS', VERSION_B)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: VERSION_B,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      `the newest code-review verdict was cast against objectives version ${VERSION_A}, the Issue's list is now ${VERSION_B}`
    )
  })

  it('fails, naming "none", when a clean verdict carries no Objectives version: line at all', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, boundComment('PASS', VERSION_A)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: VERSION_A,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      `the newest code-review verdict was cast against objectives version none, the Issue's list is now ${VERSION_A}`
    )
  })

  it('a null current objectives version skips the binding entirely — pre-cutover PR stock keeps passing', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })

  it('an objectives edit alone (head unchanged) still voids a verdict cast against the old version', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', VERSION_A), boundComment('PASS', VERSION_A)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: VERSION_B,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('code-review verdict was cast against objectives version')
    expect(result.reason).toContain('security-review verdict was cast against objectives version')
  })
})

describe('checkReviewGate — ruling-freshness binding (review-validity-v1 task 3, #477, O2)', () => {
  const boundComment = (verdict: string, ordinal: number) =>
    principal(
      `VERDICT: ${verdict}\n\nJudged head: ${HEAD_SHA}\n\nRuling ordinal: ${ordinal}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`
    )

  it('passes when both verdicts carry the current newest ruling ordinal', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', 1), boundComment('PASS', 1)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 1
    })
    expect(result.verdict).toBe('pass')
  })

  it('fails, naming the newer ruling, when a clean verdict was cast against an older ruling ordinal — a ruling posted after approval turns the gate red', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', 1), boundComment('PASS', 1)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 2
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      'the newest code-review verdict was cast against ruling ordinal 1, a newer ruling (ruling 2) is now posted on this PR'
    )
    expect(result.reason).toContain(
      'the newest security-review verdict was cast against ruling ordinal 1, a newer ruling (ruling 2) is now posted on this PR'
    )
  })

  it('fails, naming "none", when a clean verdict carries no Ruling ordinal: line at all but the PR now has a ruling', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 1
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      'the newest code-review verdict was cast against ruling ordinal none, a newer ruling (ruling 1) is now posted on this PR'
    )
  })

  it('a verdict with no Ruling ordinal: line still binds when the PR has never had a ruling (pre-cutover stock, current ordinal 0)', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })

  it('an explicit Ruling ordinal: 0 verdict still binds against a PR with no rulings', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', 0), boundComment('PASS', 0)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })
})

describe('isChangesetsReleasePr', () => {
  it('exempts only when BOTH the branch and author match the CALLER-SUPPLIED expected author', () => {
    expect(isChangesetsReleasePr('changeset-release/main', 'github-actions[bot]', 'github-actions[bot]')).toBe(true)
  })

  it('the expected author is caller-resolved, not hardcoded — a repo whose real release PRs are opened by a custom token owner exempts on THAT login, not the stock default', () => {
    expect(isChangesetsReleasePr('changeset-release/main', 'daniboomerang', 'daniboomerang')).toBe(true)
    expect(isChangesetsReleasePr('changeset-release/main', 'github-actions[bot]', 'daniboomerang')).toBe(false)
  })

  it('does NOT exempt on branch name alone — the exact hole found live (security review, PR #165)', () => {
    expect(isChangesetsReleasePr('changeset-release/main', 'some-attacker', 'github-actions[bot]')).toBe(false)
    expect(isChangesetsReleasePr('changeset-release/main', null, 'github-actions[bot]')).toBe(false)
  })

  it('does NOT exempt on author alone — a real bot action on a differently-named branch is not this PR', () => {
    expect(isChangesetsReleasePr('some-other-branch', 'github-actions[bot]', 'github-actions[bot]')).toBe(false)
  })

  it('fails closed on empty/null input', () => {
    expect(isChangesetsReleasePr('', null, 'github-actions[bot]')).toBe(false)
    expect(isChangesetsReleasePr('changeset-release/main', '', 'github-actions[bot]')).toBe(false)
  })
})

describe('checkReviewGate — patch-identity binding', () => {
  const JUDGED = `aaaaaaa${'1'.repeat(33)}`
  const CURRENT = `bbbbbbb${'2'.repeat(33)}`

  function comments(head: string) {
    return [
      {
        body: `VERDICT: APPROVE\n\nJudged head: ${head}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`,
        author: 'daniboomerang'
      },
      {
        body: `VERDICT: PASS\n\nJudged head: ${head}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`,
        author: 'daniboomerang'
      }
    ]
  }

  const BASE = {
    labels: [] as string[],
    waiverLabelActor: null,
    principalAllowlist: ['daniboomerang'],
    mechanicalChecks: [{ name: 'ci', bucket: 'pass' }],
    objectivesVersion: null as string | null,
    rulingOrdinal: 0
  }

  it('counts a verdict bound to a superseded sha whose patch identity is unchanged', () => {
    const result = checkReviewGate({
      ...BASE,
      comments: comments(JUDGED),
      headSha: CURRENT,
      patchIdOf: () => 'samepatchid'
    })
    expect(result.verdict).toBe('pass')
  })

  it('does NOT count it when the patch identity differs', () => {
    const result = checkReviewGate({
      ...BASE,
      comments: comments(JUDGED),
      headSha: CURRENT,
      patchIdOf: (sha) => (sha === JUDGED ? 'oldpatchid' : 'newpatchid')
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(JUDGED)
  })

  it('falls back to sha binding alone when patchIdOf returns null for the judged head', () => {
    const result = checkReviewGate({
      ...BASE,
      comments: comments(JUDGED),
      headSha: CURRENT,
      patchIdOf: (sha) => (sha === JUDGED ? null : 'newpatchid')
    })
    expect(result.verdict).toBe('fail')
  })

  it('falls back to sha binding alone when patchIdOf returns null for the current head', () => {
    const result = checkReviewGate({
      ...BASE,
      comments: comments(JUDGED),
      headSha: CURRENT,
      patchIdOf: (sha) => (sha === CURRENT ? null : 'oldpatchid')
    })
    expect(result.verdict).toBe('fail')
  })

  it('still passes on plain sha binding when patchIdOf is omitted entirely', () => {
    const result = checkReviewGate({ ...BASE, comments: comments(CURRENT), headSha: CURRENT })
    expect(result.verdict).toBe('pass')
  })

  it('never lets an equal patch identity rescue a verdict that is not clean', () => {
    const result = checkReviewGate({
      ...BASE,
      comments: [
        { body: `VERDICT: REQUEST CHANGES\n\nJudged head: ${JUDGED}`, author: 'daniboomerang' },
        { body: `VERDICT: PASS\n\nJudged head: ${JUDGED}`, author: 'daniboomerang' }
      ],
      headSha: CURRENT,
      patchIdOf: () => 'samepatchid'
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('not a clean APPROVE')
  })
})

// ---- Brief-hash binding (review-validity-v1 task 4, #478, O1) ------------

describe('checkReviewGate — brief-hash binding', () => {
  const HASH_A = 'a'.repeat(64)
  const HASH_B = 'b'.repeat(64)

  const boundComment = (verdict: string, hash: string) =>
    principal(
      `VERDICT: ${verdict}\n\nJudged head: ${HEAD_SHA}\n\nRuling ordinal: 0\n\nBrief hash: ${hash}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}`
    )

  it('passes when both verdicts carry the current brief hash', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', HASH_A), boundComment('PASS', HASH_A)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0,
      briefHash: HASH_A
    })
    expect(result.verdict).toBe('pass')
  })

  it('fails, naming both hashes, when a clean verdict was cast against a superseded frozen brief', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', HASH_A), boundComment('PASS', HASH_A)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0,
      briefHash: HASH_B
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      `the newest code-review verdict was cast against brief hash ${HASH_A}, the frozen brief's current hash is ${HASH_B}`
    )
    expect(result.reason).toContain(
      `the newest security-review verdict was cast against brief hash ${HASH_A}, the frozen brief's current hash is ${HASH_B}`
    )
  })

  it('omitting briefHash entirely (every caller predating this field) skips the binding — the two new fixtures above are the only behavior change', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', HASH_A), boundComment('PASS', HASH_A)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })

  it('a null current briefHash (no frozen brief resolvable) skips the binding, even against a stale echoed hash', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', HASH_A), boundComment('PASS', HASH_A)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0,
      briefHash: null
    })
    expect(result.verdict).toBe('pass')
  })

  it('fails, naming "none", when a clean verdict carries no Brief hash: line at all but a brief is now resolvable', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0,
      briefHash: HASH_A
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      `the newest code-review verdict was cast against brief hash none, the frozen brief's current hash is ${HASH_A}`
    )
  })
})

// ---- Policy-digest binding (review-validity-v1 task 4, #478, O5) ---------

describe('checkReviewGate — policy-digest binding', () => {
  const boundComment = (verdict: string, digest: string) =>
    principal(
      `VERDICT: ${verdict}\n\nJudged head: ${HEAD_SHA}\n\nRuling ordinal: 0\n\nBrief hash: (none)\n\nPolicy digest: ${digest}`
    )

  it('passes when both verdicts carry a digest matching the current (default) policy', () => {
    // The real digest value is an implementation detail of `policyDigest` —
    // this fixture reads it back from the gate's own failure message on a
    // deliberate mismatch (below) rather than importing the hash function,
    // so the test does not silently drift if the digest algorithm changes.
    const mismatch = checkReviewGate({
      comments: [boundComment('APPROVE', '1'.repeat(64)), boundComment('PASS', '1'.repeat(64))],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    const m = /current policy digest is ([0-9a-f]{64})/.exec(mismatch.reason)
    const currentDigest = m?.[1] as string
    expect(currentDigest).toMatch(/^[0-9a-f]{64}$/)

    const result = checkReviewGate({
      comments: [boundComment('APPROVE', currentDigest), boundComment('PASS', currentDigest)],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('pass')
  })

  it('fails when a clean verdict was cast against a policy digest that no longer matches the current one', () => {
    const result = checkReviewGate({
      comments: [boundComment('APPROVE', '1'.repeat(64)), boundComment('PASS', '1'.repeat(64))],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('was cast against review policy digest')
  })

  it('a legacy comment with no Policy digest: line at all does NOT bind — unlike every other field, a policy is always resolvable so a missing line is never grandfathered (#478 round 4, security MEDIUM)', () => {
    const legacyApprove = principal(
      `VERDICT: APPROVE\n\nJudged head: ${HEAD_SHA}\n\nBRIEF CONFORMANCE: clean. Looks good.`
    )
    const legacyPass = principal(`VERDICT: PASS\n\nJudged head: ${HEAD_SHA}\n\nFINDINGS: none.`)
    const result = checkReviewGate({
      comments: [legacyApprove, legacyPass],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('was cast against review policy digest')
  })
})

// ---- Which severities block is repository policy (review-validity-v1 task
// 8, #506, O2/O3/O4) — a reviewer's own APPROVE/PASS never overrides the
// evaluator: a comment's FINDINGS block is re-evaluated against `policy`
// regardless of what its VERDICT: line claims.

describe('checkReviewGate — policy evaluation (O2/O3)', () => {
  const findings = (lines: string[]) => (lines.length > 0 ? lines.join('\n') : 'None.')
  const MAJOR_HIGH_POLICY = { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 } as const
  const MAJOR_HIGH_POLICY_DIGEST = policyDigest(MAJOR_HIGH_POLICY)

  const codeReviewComment = (verdictLine: string, findingLines: string[] = [], digest = DEFAULT_POLICY_DIGEST) =>
    principal(
      `VERDICT: ${verdictLine}\n\nJudged head: ${HEAD_SHA}\n\nFINDINGS (ordered by severity):\n${findings(findingLines)}\n\nPolicy digest: ${digest}`
    )
  const securityComment = (verdictLine: string, findingLines: string[] = [], digest = DEFAULT_POLICY_DIGEST) =>
    principal(
      `VERDICT: ${verdictLine}\n\nJudged head: ${HEAD_SHA}\n\nFINDINGS (ordered by severity):\n${findings(findingLines)}\n\nPolicy digest: ${digest}`
    )

  const BASE_INPUT = {
    labels: [],
    waiverLabelActor: null,
    mechanicalChecks: CLEAN_CHECKS,
    headSha: HEAD_SHA,
    objectivesVersion: null,
    rulingOrdinal: 0
  }

  it("an APPROVE beside a MAJOR finding reads as not clean under this repo's MAJOR/HIGH policy — a reviewer's own APPROVE never overrides the evaluator (O3)", () => {
    const result = checkReviewGate({
      ...BASE_INPUT,
      comments: [codeReviewComment('APPROVE', ['1. [MAJOR] a.ts:1 — off-by-one']), securityComment('PASS')],
      policy: { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 }
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('never overrides policy')
    expect(result.reason).toContain('MAJOR')
  })

  it('the identical MAJOR finding reads as clean under the DEFAULT (BLOCKER) policy — only a MAJOR-or-above threshold blocks it', () => {
    const result = checkReviewGate({
      ...BASE_INPUT,
      comments: [codeReviewComment('APPROVE', ['1. [MAJOR] a.ts:1 — off-by-one']), securityComment('PASS')]
      // policy omitted — defaults to BLOCKER/HIGH.
    })
    expect(result.verdict).toBe('pass')
  })

  it('a MEDIUM security finding does not block at the HIGH threshold', () => {
    const result = checkReviewGate({
      ...BASE_INPUT,
      comments: [
        codeReviewComment('APPROVE', [], MAJOR_HIGH_POLICY_DIGEST),
        securityComment('PASS', ['1. [MEDIUM] a.ts:1 — informational'], MAJOR_HIGH_POLICY_DIGEST)
      ],
      policy: MAJOR_HIGH_POLICY
    })
    expect(result.verdict).toBe('pass')
  })

  it('a PASS beside a HIGH finding reads as not clean under an HIGH-or-above security policy', () => {
    const result = checkReviewGate({
      ...BASE_INPUT,
      comments: [codeReviewComment('APPROVE'), securityComment('PASS', ['1. [HIGH] a.ts:1 — leaked pattern'])],
      policy: { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 }
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('security-review verdict says PASS but carries a finding')
  })

  it('a clean REQUEST CHANGES/FAIL text is refused on the text check first — the policy problem message never fires for an already-not-clean text value', () => {
    const result = checkReviewGate({
      ...BASE_INPUT,
      comments: [codeReviewComment('REQUEST_CHANGES', ['1. [BLOCKER] a.ts:1 — real bug']), securityComment('PASS')],
      policy: { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 }
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('not a clean APPROVE')
    expect(result.reason).not.toContain('never overrides policy')
  })

  it('a severity token off the code-review scale in a hand-typed comment fails closed with a named reason, never an uncaught throw (#526 round 2 MINOR)', () => {
    // "CRITICAL" is a security-scale token; findingSeverities is a bare
    // regex extraction over free-typed comment text, so nothing stops it
    // reaching a code-review comment's own FINDINGS block by typo.
    expect(() =>
      checkReviewGate({
        ...BASE_INPUT,
        comments: [
          codeReviewComment('APPROVE', ['1. [CRITICAL] a.ts:1 — off-scale severity']),
          securityComment('PASS')
        ],
        policy: { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 }
      })
    ).not.toThrow()

    const result = checkReviewGate({
      ...BASE_INPUT,
      comments: [codeReviewComment('APPROVE', ['1. [CRITICAL] a.ts:1 — off-scale severity']), securityComment('PASS')],
      policy: { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 }
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('does not recognize')
  })
})
