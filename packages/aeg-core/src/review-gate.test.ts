import { describe, expect, it } from 'vitest'
import { checkReviewGate, isReviewGateExemptBranch } from './review-gate'

import type { ReviewGateComment } from './review-gate'

/** Principal-authored comment — the allowlisted author every legitimate verdict flows through. */
const principal = (body: string): ReviewGateComment => ({ body, author: 'daniboomerang' })
/** Forged comment — an arbitrary GitHub account (security finding, PR #806). */
const forged = (body: string): ReviewGateComment => ({ body, author: 'drive-by-account' })

const APPROVE_COMMENT = principal('VERDICT: APPROVE\n\nBRIEF CONFORMANCE: clean. Looks good.')
const PASS_COMMENT = principal('VERDICT: PASS\n\nFINDINGS: none.')
const REQUEST_CHANGES_COMMENT = principal('VERDICT: REQUEST_CHANGES\n\nsee inline notes.')
const FAIL_COMMENT = principal('VERDICT: FAIL\n\nhardcoded credential found.')

describe('checkReviewGate', () => {
  it('passes when both verdicts are clean (APPROVE + PASS)', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('pass')
    expect(result.waived).toBe(false)
  })

  it('fails when no review comments exist at all (the historical-PR case, e.g. PR #435)', () => {
    const result = checkReviewGate({ comments: [], labels: [], waiverLabelActor: null })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('code-reviewer verdict is not a clean APPROVE')
    expect(result.reason).toContain('security-review verdict is not a clean PASS')
  })

  it('fails when code review is REQUEST_CHANGES even though security is PASS', () => {
    const result = checkReviewGate({
      comments: [REQUEST_CHANGES_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('code-reviewer verdict is not a clean APPROVE (found: REQUEST CHANGES)')
  })

  it('fails when security is FAIL even though code review is APPROVE', () => {
    const result = checkReviewGate({
      comments: [APPROVE_COMMENT, FAIL_COMMENT],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('security-review verdict is not a clean PASS (found: FAIL)')
  })

  it('fails when only one of the two verdicts is present', () => {
    const result = checkReviewGate({ comments: [APPROVE_COMMENT], labels: [], waiverLabelActor: null })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('security-review verdict is not a clean PASS')
  })

  it('passes when both verdicts are clean, regardless of comment order', () => {
    const result = checkReviewGate({
      comments: [PASS_COMMENT, APPROVE_COMMENT],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('pass')
  })

  describe('vinaya/waiver:review actor verification', () => {
    it('label absent → gate still evaluates verdicts normally (fails on empty comments)', () => {
      const result = checkReviewGate({ comments: [], labels: ['vinaya/tier:1'], waiverLabelActor: 'daniboomerang' })
      expect(result.verdict).toBe('fail')
      expect(result.waived).toBe(false)
    })

    it('label present, actor not in allowlist → ignored, gate still fails on missing verdicts', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/waiver:review'],
        waiverLabelActor: 'some-agent-bot'
      })
      expect(result.verdict).toBe('fail')
      expect(result.waived).toBe(false)
    })

    it('label present, actor null (no labeling event found) → ignored, gate fails', () => {
      const result = checkReviewGate({ comments: [], labels: ['vinaya/waiver:review'], waiverLabelActor: null })
      expect(result.verdict).toBe('fail')
      expect(result.waived).toBe(false)
    })

    it('label present, actor in allowlist → passes without any review comments', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/waiver:review'],
        waiverLabelActor: 'daniboomerang'
      })
      expect(result.verdict).toBe('pass')
      expect(result.waived).toBe(true)
    })

    it('a different label (vinaya/waiver:docs) applied by the principal does not waive the review gate', () => {
      const result = checkReviewGate({
        comments: [],
        labels: ['vinaya/waiver:docs'],
        waiverLabelActor: 'daniboomerang'
      })
      expect(result.verdict).toBe('fail')
      expect(result.waived).toBe(false)
    })
  })
})

describe('isReviewGateExemptBranch', () => {
  it('exempts a plan branch — topology docs only, no code', () => {
    expect(isReviewGateExemptBranch('plan/vinaya-v1')).toBe(true)
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
      comments: [forged('VERDICT: APPROVE\n\nlooks great!'), forged('VERDICT: PASS\n\nno findings.')],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain(
      '2 verdict-shaped comment(s) from authors outside the principal allowlist were ignored'
    )
  })

  it('a forged later APPROVE does not override a real REQUEST_CHANGES', () => {
    const result = checkReviewGate({
      comments: [REQUEST_CHANGES_COMMENT, PASS_COMMENT, forged('VERDICT: APPROVE\n\noverriding!')],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('code-reviewer verdict is not a clean APPROVE')
  })

  it('a null-author comment is ignored, not fatal', () => {
    const result = checkReviewGate({
      comments: [{ body: 'VERDICT: APPROVE', author: null }, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null
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
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).not.toContain('were ignored')
  })

  it('verified verdicts still pass with forged noise present', () => {
    const result = checkReviewGate({
      comments: [forged('VERDICT: FAIL\n\nchaos'), APPROVE_COMMENT, PASS_COMMENT],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('pass')
  })
})

describe('checkReviewGate — configurable principalAllowlist (adopter-repo fix)', () => {
  const adopterApprove = (author: string) => ({ body: 'VERDICT: APPROVE\n\nclean.', author })
  const adopterPass = (author: string) => ({ body: 'VERDICT: PASS\n\nno findings.', author })

  it('a caller with no principalAllowlist keeps the default PRINCIPAL_ALLOWLIST behavior (backward compatible)', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('someone-else'), adopterPass('someone-else')],
      labels: [],
      waiverLabelActor: null
      // no principalAllowlist passed
    })
    expect(result.verdict).toBe('fail') // 'someone-else' isn't the hardcoded default
  })

  it('an overridden principalAllowlist counts a verdict from an adopter-trusted author', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('someone-else'), adopterPass('someone-else')],
      labels: [],
      waiverLabelActor: null,
      principalAllowlist: ['someone-else']
    })
    expect(result.verdict).toBe('pass')
  })

  it('matches logins case-insensitively, as GitHub itself does — a config that wrote "Alice" still counts alice’s verdicts', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('alice'), adopterPass('ALICE')],
      labels: [],
      waiverLabelActor: null,
      principalAllowlist: ['Alice']
    })
    expect(result.verdict).toBe('pass')
  })

  it('case-insensitivity does not widen trust — a genuinely different login is still ignored', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('alice-bot'), adopterPass('alice-bot')],
      labels: [],
      waiverLabelActor: null,
      principalAllowlist: ['Alice']
    })
    expect(result.verdict).toBe('fail')
  })

  it('an overridden principalAllowlist is a true REPLACEMENT, not additive — the hardcoded default author no longer counts once overridden', () => {
    const result = checkReviewGate({
      comments: [adopterApprove('daniboomerang'), adopterPass('daniboomerang')],
      labels: [],
      waiverLabelActor: null,
      principalAllowlist: ['someone-else'] // daniboomerang deliberately excluded
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
      principalAllowlist: []
    })
    expect(result.verdict).toBe('fail')
    expect(result.waived).toBe(false)
  })

  it('an EMPTY principalAllowlist also refuses the waiver label, whoever applied it', () => {
    const result = checkReviewGate({
      comments: [],
      labels: ['vinaya/waiver:review'],
      waiverLabelActor: 'daniboomerang',
      principalAllowlist: []
    })
    expect(result.verdict).toBe('fail')
    expect(result.waived).toBe(false)
  })
})

/**
 * CHARACTERIZATION, NOT ENDORSEMENT — `atta-labs/vinaya#71`, open.
 *
 * `checkReviewGate` resolves verdicts by RECENCY only. Nothing in
 * `ReviewGateInput` carries the PR's head SHA or any comment timestamp, so a
 * verdict cast against a tree that no longer exists is indistinguishable, to
 * this function, from one cast against the current tree.
 *
 * The tests below pin what the gate does TODAY so that the fix for #71 — which
 * necessarily changes `ReviewGateInput`'s signature (a `headSha`, or per-comment
 * `createdAt` compared against the head commit's committer date) — has to come
 * back here and flip these expectations deliberately. A silent behavior change
 * in either direction is what this pins against.
 *
 * The fixture is the live instance named in this task's brief:
 * `atta-labs/attalabs#953`, whose security `PASS` names head `ab0f47c0` while
 * the PR head is `d48236d2`.
 *
 * Testing the CORRECT behavior is impossible from here without that signature
 * change, which this task's brief puts out of scope (STOP condition) — hence
 * characterization plus this note, not a `.todo`/`.fails` test that would read
 * as if the gap were merely unimplemented rather than shipped.
 */
describe('checkReviewGate — verdicts are not bound to a tree (#71, OPEN)', () => {
  const PR_HEAD = 'd48236d2'
  const SUPERSEDED_HEAD = 'ab0f47c0'

  it('accepts a security PASS that names a superseded head (attalabs#953, live)', () => {
    const result = checkReviewGate({
      comments: [
        APPROVE_COMMENT,
        principal(`VERDICT: PASS\n\nReviewed at head \`${SUPERSEDED_HEAD}\`.\n\nSECRETS: none found.`)
      ],
      labels: [],
      waiverLabelActor: null
    })
    // The verdict names a tree that is no longer the PR's head — and the gate
    // is green anyway, because it never sees `PR_HEAD` at all.
    expect(SUPERSEDED_HEAD).not.toBe(PR_HEAD)
    expect(result.verdict).toBe('pass')
    expect(result.waived).toBe(false)
    // Nothing in the reason mentions staleness: the caller gets no signal either.
    expect(result.reason).not.toMatch(/stale|superseded|head/i)
  })

  it('accepts an APPROVE + PASS pair that predates a force-push, with no signal that the diff changed', () => {
    // #71's reproduction, reduced: the reviewer approved head `52107b3`; a
    // rebase replaced it with an unrelated `945b3af`; no new verdict was cast.
    // The comment stream is byte-identical to a genuinely-reviewed PR's.
    const result = checkReviewGate({
      comments: [
        principal('VERDICT: APPROVE\n\nreviewed at 52107b3'),
        principal('VERDICT: PASS\n\nreviewed at 52107b3')
      ],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('pass')
  })

  it('an explicitly RETRACTED verdict still loses to recency, not to retraction (the only working escape today)', () => {
    // The one thing that DOES work: casting a newer verdict. #71's live
    // instance was caught only because the reviewer re-checked the SHA itself
    // and posted a superseding FAIL — discipline substituting for a mechanism.
    const result = checkReviewGate({
      comments: [
        APPROVE_COMMENT,
        principal(`VERDICT: PASS\n\nReviewed at head \`${SUPERSEDED_HEAD}\`.`),
        principal(`VERDICT: FAIL\n\nprevious PASS was against ${SUPERSEDED_HEAD}, head is now ${PR_HEAD}.`)
      ],
      labels: [],
      waiverLabelActor: null
    })
    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('security-review verdict is not a clean PASS (found: FAIL)')
  })
})
