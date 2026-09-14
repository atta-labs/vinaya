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
import { briefHash, policyDigest, DEFAULT_REVIEW_POLICY, type ReviewInputManifest } from '@attalabs/aeg-core'
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

  it('base-only change (identical head, moved base) invalidates — no patchIdOf is ever supplied here, unlike the merge gate', () => {
    const current = manifest({ baseSha: 'e'.repeat(40) })
    const result = bindingOfPosted(posted(), current)
    expect(result.head).toBe(true)
    expect(result.base).toBe(false)
    expect(result.bound).toBe(false)
    expect(unboundFields(result)).toEqual(['base'])
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
    const result = bindingOfPosted(
      posted({ baseSha: 'e'.repeat(40), rulingOrdinal: 0 }),
      manifest({ rulingOrdinal: 2 })
    )
    expect(unboundFields(result)).toEqual(['base', 'ruling ordinal'])
  })
})
