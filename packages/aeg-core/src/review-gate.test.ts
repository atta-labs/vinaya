import { describe, expect, it } from 'vitest'
import { checkReviewGate, isChangesetsReleasePr, isReviewGateExemptBranch } from './review-gate'

import type { MechanicalCheckStatus, ReviewGateComment } from './review-gate'

/** A single green check-run — the default "mechanical checks are clean" fixture for tests that are about verdict logic, not mechanical-check logic. */
const CLEAN_CHECKS: MechanicalCheckStatus[] = [{ name: 'Vinaya CI', bucket: 'pass' }]

/** Principal-authored comment — the allowlisted author every legitimate verdict flows through. */
const principal = (body: string): ReviewGateComment => ({ body, author: 'daniboomerang' })
/** Forged comment — an arbitrary GitHub account (security finding, PR #806). */
const forged = (body: string): ReviewGateComment => ({ body, author: 'drive-by-account' })

/** The PR's current head throughout this file's main test block, unless a test says otherwise. */
const HEAD_SHA = '8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f'

// Judged head: sits on line 3, matching the real render shape
// (`review-post.ts`'s templates put `VERDICT:`/`Judged head:` on lines 1/3,
// never later) — the extractors now read both markers from a comment's
// first three lines only (round-4 ruling, `#392`). These fixtures test
// decoration, not marker position, so the decoration moves after the head.
const APPROVE_COMMENT = principal(
  `VERDICT: APPROVE\n\nJudged head: ${HEAD_SHA}\n\nBRIEF CONFORMANCE: clean. Looks good.`
)
const PASS_COMMENT = principal(`VERDICT: PASS\n\nJudged head: ${HEAD_SHA}\n\nFINDINGS: none.`)
const REQUEST_CHANGES_COMMENT = principal(`VERDICT: REQUEST_CHANGES\n\nJudged head: ${HEAD_SHA}\n\nsee inline notes.`)
const FAIL_COMMENT = principal(`VERDICT: FAIL\n\nJudged head: ${HEAD_SHA}\n\nhardcoded credential found.`)

describe('checkReviewGate', () => {
  it('passes when both verdicts are clean (APPROVE + PASS) and both cover the current head', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
          principal(`VERDICT: APPROVE\n\nJudged head: ${shortSha}`),
          principal(`VERDICT: PASS\n\nJudged head: ${shortSha}`)
        ],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: CLEAN_CHECKS,
        headSha: HEAD_SHA
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
        headSha: newHeadAfterPush
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
          principal(`VERDICT: APPROVE\n\nJudged head: ${newHeadAfterPush}\n\nsupersedes my prior pass.`),
          principal(`VERDICT: PASS\n\nJudged head: ${newHeadAfterPush}\n\nsupersedes my prior pass.`)
        ],
        labels: [],
        waiverLabelActor: null,
        mechanicalChecks: CLEAN_CHECKS,
        headSha: newHeadAfterPush
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
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
        headSha: HEAD_SHA
      })
      expect(result.verdict).toBe('pass')
      expect(result.waived).toBe(true)
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
    })
    expect(result.verdict).toBe('pass')
  })
})

describe('checkReviewGate — configurable principalAllowlist (adopter-repo fix)', () => {
  const adopterApprove = (author: string) => ({
    body: `VERDICT: APPROVE\n\nJudged head: ${HEAD_SHA}\n\nclean.`,
    author
  })
  const adopterPass = (author: string) => ({
    body: `VERDICT: PASS\n\nJudged head: ${HEAD_SHA}\n\nno findings.`,
    author
  })

  it('a caller with no principalAllowlist keeps the default PRINCIPAL_ALLOWLIST behavior (backward compatible)', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('someone-else'), adopterPass('someone-else')],
      labels: [],
      waiverLabelActor: null,
      mechanicalChecks: CLEAN_CHECKS,
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: HEAD_SHA
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
      headSha: PR_HEAD
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
      headSha: newHead
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
      headSha: PR_HEAD
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('security-review verdict is not a clean PASS (found: FAIL)')
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
