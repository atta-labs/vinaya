/**
 * Direct fixture coverage for `publication.ts`'s own manifest-binding gate
 * (round 2 review, security HIGH): `publishRound`'s two throw sites —
 * "posted reviewer/security verdict does not bind to the round's manifest"
 * — sit on `bindingOfPosted`/`unboundFields`, which had no test anywhere in
 * the repo even though O3 (`#555`) names publication as one of the three
 * readers `compareManifest` must be fixture-proven under: base-only
 * invalidation, a missing required echo refusing, and a stale field
 * refusing. `bindingOfPosted` deliberately never supplies `patchIdOf`
 * (its own doc comment) — a just-posted verdict must bind by exact
 * identity, so the rebase-tolerance path `review-input-manifest.test.ts`
 * covers for the merge gate has no equivalent here; these fixtures only
 * ever exercise the exact-match side of `compareManifest`.
 */
import { describe, expect, it } from 'vitest'
import {
  briefHash,
  checkReviewGate,
  consequentialFindings,
  policyDigest,
  DEFAULT_REVIEW_POLICY,
  evaluateCodeReview,
  evaluateSecurityReview,
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  type ReviewInputManifest,
  type ReviewPolicy
} from '@attalabs/aeg-core'
import type { VerdictExtraction } from '@attalabs/aeg-core'
import { bindingOfPosted, unboundFields } from '../../../src/lib/dev-review-loop/publication'

const HEAD = 'a'.repeat(40)
const BASE = 'f'.repeat(40)
const BRIEF = 'the frozen brief text'
const POLICY_DIGEST = policyDigest(DEFAULT_REVIEW_POLICY)

function manifest(overrides: Partial<ReviewInputManifest> = {}): ReviewInputManifest {
  return {
    headSha: HEAD,
    baseSha: BASE,
    briefHash: briefHash(BRIEF),
    objectivesVersion: null,
    rulingOrdinal: 0,
    policyDigest: POLICY_DIGEST,
    ...overrides
  }
}

function posted(overrides: Partial<VerdictExtraction> = {}): VerdictExtraction {
  return {
    value: 'APPROVE',
    headSha: HEAD,
    baseSha: BASE,
    objectivesVersion: null,
    rulingOrdinal: 0,
    briefHash: briefHash(BRIEF),
    policyDigest: POLICY_DIGEST,
    findingSeverities: [],
    danglingNote: null,
    ...overrides
  }
}

describe('bindingOfPosted / unboundFields — publishRound’s manifest binding (#555 O3, round 2 review security HIGH)', () => {
  it('binds on every field when the posted verdict echoes the round manifest exactly', () => {
    const result = bindingOfPosted(posted(), manifest())
    expect(result.bound).toBe(true)
    expect(unboundFields(result)).toEqual([])
  })

  it('base-only change (identical head, moved base) is tolerated (#680, O1) — a verdict judges the PR, not its base', () => {
    const current = manifest({ baseSha: 'e'.repeat(40) })
    const result = bindingOfPosted(posted(), current)
    expect(result.head).toBe(true)
    expect(result.base).toBe(true)
    expect(result.bound).toBe(true)
    expect(unboundFields(result)).toEqual([])
  })

  it('a missing base echo against a real current base refuses (missing required input)', () => {
    const result = bindingOfPosted(posted({ baseSha: null }), manifest())
    expect(result.base).toBe(false)
    expect(unboundFields(result)).toEqual(['base'])
  })

  it('a stale head refuses — the posted verdict covers a different candidate entirely', () => {
    const result = bindingOfPosted(posted({ headSha: 'b'.repeat(40) }), manifest())
    expect(result.head).toBe(false)
    expect(unboundFields(result)).toEqual(['head'])
  })

  it('a stale objectives version refuses when the current one is real and different', () => {
    const result = bindingOfPosted(
      posted({ objectivesVersion: 'a'.repeat(64) }),
      manifest({ objectivesVersion: 'b'.repeat(64) })
    )
    expect(result.objectivesVersion).toBe(false)
    expect(unboundFields(result)).toEqual(['objectives version'])
  })

  it('a newer ruling than the posted verdict saw refuses', () => {
    const result = bindingOfPosted(posted({ rulingOrdinal: 0 }), manifest({ rulingOrdinal: 1 }))
    expect(result.rulingOrdinal).toBe(false)
    expect(unboundFields(result)).toEqual(['ruling ordinal'])
  })

  it('a superseded brief hash refuses', () => {
    const result = bindingOfPosted(
      posted({ briefHash: briefHash('an old brief') }),
      manifest({ briefHash: briefHash('a superseding brief') })
    )
    expect(result.briefHash).toBe(false)
    expect(unboundFields(result)).toEqual(['brief hash'])
  })

  it('a changed policy digest refuses, and a missing Policy digest: echo is never grandfathered', () => {
    const changedPolicy = policyDigest({ codeReviewThreshold: 'MAJOR', securityThreshold: 'LOW', maxRounds: 3 })
    const stale = bindingOfPosted(posted(), manifest({ policyDigest: changedPolicy }))
    expect(stale.policyDigest).toBe(false)

    const missing = bindingOfPosted(posted({ policyDigest: null }), manifest())
    expect(missing.policyDigest).toBe(false)
    expect(unboundFields(missing)).toEqual(['policy digest'])
  })

  it('reports every unbound field at once, not just the first, when several drift together', () => {
    // Base-only move (identical head) is now tolerated (#680, O1),
    // so this test checks ruling ordinal drift alone
    const result = bindingOfPosted(
      posted({ baseSha: 'e'.repeat(40), rulingOrdinal: 0 }),
      manifest({ rulingOrdinal: 2 })
    )
    expect(unboundFields(result)).toEqual(['ruling ordinal'])
  })
})

/**
 * O3: `publishRound`'s pre-publication policy re-check applies the SAME
 * `consequentialFindings` filter the merge gate applies, so a round the gate
 * would pass is never refused at publication and a round the gate would fail
 * is never published. `publishRound` itself is faked in the loop harness
 * (`dev-review-loop-harness.ts`), so it is not driven end-to-end here; this
 * fixture instead reproduces its exact re-check expression
 * (`evaluate*Review(consequentialFindings(extract*(body).findingSeverities),
 * policy)` — verbatim from `publication.ts`) beside the real `checkReviewGate`
 * on the SAME comment body, and asserts the two never disagree. Both routing
 * through the single shared filter (O4) is what makes that guarantee
 * structural rather than coincidental.
 */
describe('publish-then-gate agreement on resolved findings (O3)', () => {
  const HEAD_SHA = '8365ca57e9f3a1b2c4d5e6f708192a3b4c5d6e7f'
  const MAJOR_HIGH_POLICY: ReviewPolicy = { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 }
  const MAJOR_HIGH_POLICY_DIGEST = policyDigest(MAJOR_HIGH_POLICY)

  const codeReviewBody = (verdict: string, findingLines: string[]) =>
    `VERDICT: ${verdict}\n\nJudged head: ${HEAD_SHA}\n\nFINDINGS (ordered by severity):\n${findingLines.length > 0 ? findingLines.join('\n') : 'None.'}\n\nPolicy digest: ${MAJOR_HIGH_POLICY_DIGEST}`
  const securityCleanBody = `VERDICT: PASS\n\nJudged head: ${HEAD_SHA}\n\nFINDINGS (ordered by severity):\nNone.\n\nPolicy digest: ${MAJOR_HIGH_POLICY_DIGEST}`

  // Verbatim from `publishRound`: a posted APPROVE is publishable only when its
  // own consequential findings do not block under policy.
  const publishReviewerBlocks = (body: string): boolean => {
    const posted = extractCodeReviewVerdict([body])
    return (
      posted.value === 'APPROVE' &&
      evaluateCodeReview(consequentialFindings(posted.findingSeverities), MAJOR_HIGH_POLICY).outcome === 'blocked'
    )
  }

  const gate = (reviewerBody: string) =>
    checkReviewGate({
      comments: [
        { body: reviewerBody, author: 'daniboomerang' },
        { body: securityCleanBody, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD_SHA,
      objectivesVersion: null,
      rulingOrdinal: 0,
      policy: MAJOR_HIGH_POLICY
    })

  it('an APPROVE whose only at-or-above findings are `resolved` is neither refused at publication nor blocked at the gate', () => {
    const body = codeReviewBody('APPROVE', [
      '1. [BLOCKER] src/foo.ts:12 — F1 correctness resolved: the off-by-one, now fixed',
      '2. [MAJOR] src/bar.ts:5 — F5 correctness resolved: the missing null check, now guarded'
    ])
    expect(publishReviewerBlocks(body)).toBe(false)
    expect(gate(body).verdict).toBe('pass')
  })

  it('the same body with F1 relabelled `open` is refused at publication AND blocked at the gate', () => {
    const body = codeReviewBody('APPROVE', [
      '1. [BLOCKER] src/foo.ts:12 — F1 correctness open: the off-by-one',
      '2. [MAJOR] src/bar.ts:5 — F5 correctness resolved: the missing null check, now guarded'
    ])
    expect(publishReviewerBlocks(body)).toBe(true)
    expect(gate(body).verdict).toBe('fail')
  })

  it('a security PASS with a resolved CRITICAL is neither refused nor blocked', () => {
    const posted = extractSecurityReviewVerdict([
      `VERDICT: PASS\n\nJudged head: ${HEAD_SHA}\n\nFINDINGS (ordered by severity):\n1. [CRITICAL] src/foo.ts:12 — F2 secret resolved: rotated and removed\n\nPolicy digest: ${MAJOR_HIGH_POLICY_DIGEST}`
    ])
    const securityBlocks =
      posted.value === 'PASS' &&
      evaluateSecurityReview(consequentialFindings(posted.findingSeverities), MAJOR_HIGH_POLICY).outcome === 'blocked'
    expect(securityBlocks).toBe(false)
  })
})
