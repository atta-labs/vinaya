import { describe, expect, it } from 'vitest'
import {
  briefHash,
  buildReviewInputManifest,
  compareManifest,
  manifestAsEchoed,
  policyDigest,
  type EchoedManifest,
  type ReviewInputManifest
} from './review-input-manifest'
import { DEFAULT_REVIEW_POLICY } from './review-policy'

const HEAD = 'a'.repeat(40)
const BASE = 'f'.repeat(40)
const BRIEF = 'the frozen brief text'

function manifest(overrides: Partial<ReviewInputManifest> = {}): ReviewInputManifest {
  return {
    headSha: HEAD,
    baseSha: BASE,
    briefHash: briefHash(BRIEF),
    objectivesVersion: null,
    rulingOrdinal: 0,
    policyDigest: policyDigest(DEFAULT_REVIEW_POLICY),
    ...overrides
  }
}

describe('briefHash / policyDigest', () => {
  it('is deterministic — the same content always hashes the same', () => {
    expect(briefHash(BRIEF)).toBe(briefHash(BRIEF))
    expect(briefHash(BRIEF)).not.toBe(briefHash('a different brief'))
  })

  it('policyDigest differs when either threshold differs', () => {
    const a = policyDigest({ codeReviewThreshold: 'BLOCKER', securityThreshold: 'HIGH', maxRounds: 3 })
    const b = policyDigest({ codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3 })
    const c = policyDigest({ codeReviewThreshold: 'BLOCKER', securityThreshold: 'LOW', maxRounds: 3 })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a).toBe(policyDigest({ codeReviewThreshold: 'BLOCKER', securityThreshold: 'HIGH', maxRounds: 3 }))
  })

  it('policyDigest folds in the round-policy field — maxRounds changes the digest (#555, O1)', () => {
    const three = policyDigest({ codeReviewThreshold: 'BLOCKER', securityThreshold: 'HIGH', maxRounds: 3 })
    const five = policyDigest({ codeReviewThreshold: 'BLOCKER', securityThreshold: 'HIGH', maxRounds: 5 })
    expect(three).not.toBe(five)
  })
})

describe('buildReviewInputManifest', () => {
  it('builds briefHash from the resolved brief content, null when none is resolvable', () => {
    const withBrief = buildReviewInputManifest({
      headSha: HEAD,
      baseSha: BASE,
      briefContent: BRIEF,
      objectivesVersion: null,
      rulingOrdinal: 0,
      policy: DEFAULT_REVIEW_POLICY
    })
    expect(withBrief.briefHash).toBe(briefHash(BRIEF))
    expect(withBrief.baseSha).toBe(BASE)

    const withoutBrief = buildReviewInputManifest({
      headSha: HEAD,
      baseSha: null,
      briefContent: null,
      objectivesVersion: null,
      rulingOrdinal: 0,
      policy: DEFAULT_REVIEW_POLICY
    })
    expect(withoutBrief.briefHash).toBeNull()
    expect(withoutBrief.baseSha).toBeNull()
  })
})

describe('compareManifest', () => {
  it('binds when every field matches exactly', () => {
    const m = manifest()
    const result = compareManifest(manifestAsEchoed(m), m)
    expect(result).toEqual({
      bound: true,
      head: true,
      base: true,
      briefHash: true,
      objectivesVersion: true,
      rulingOrdinal: true,
      policyDigest: true
    })
  })

  it('head: binds by patch identity when the sha differs but patchIdOf agrees', () => {
    const judged = manifest({ headSha: 'b'.repeat(40) })
    const current = manifest({ headSha: 'c'.repeat(40) })
    const result = compareManifest(manifestAsEchoed(judged), current, () => 'same-patch')
    expect(result.head).toBe(true)
  })

  it('base: an equivalent rebase (patch identity holds) keeps the verdict even across a base move (#555, O1)', () => {
    // A genuine rebase: the head sha changed AND the base moved, but the diff
    // itself is proven byte-identical by patchIdOf. The base move is tolerated.
    const judged = manifest({ headSha: 'b'.repeat(40), baseSha: 'd'.repeat(40) })
    const current = manifest({ headSha: 'c'.repeat(40), baseSha: 'e'.repeat(40) })
    const result = compareManifest(manifestAsEchoed(judged), current, () => 'same-patch')
    expect(result.head).toBe(true)
    expect(result.base).toBe(true)
    expect(result.bound).toBe(true)
  })

  it('base: a base-only change (identical candidate, moved base) invalidates (#555, O1)', () => {
    // Exact head match, but the base moved under it — no patchIdOf equivalence
    // to certify the diff was re-judged against the new base. This is the one
    // narrowed acceptance this task documents.
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), baseSha: 'd'.repeat(40) }
    const current = manifest({ baseSha: 'e'.repeat(40) })
    const result = compareManifest(echoed, current)
    expect(result.head).toBe(true)
    expect(result.base).toBe(false)
    expect(result.bound).toBe(false)
  })

  it('base: a null current base (none resolvable) skips the binding — every pre-base caller/fixture is unaffected', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), baseSha: 'd'.repeat(40) }
    expect(compareManifest(echoed, manifest({ baseSha: null })).base).toBe(true)
  })

  it('base: a missing base echo against a real current base refuses (missing required input, #555, O3)', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), baseSha: null }
    const current = manifest({ baseSha: 'e'.repeat(40) })
    const result = compareManifest(echoed, current)
    expect(result.base).toBe(false)
    expect(result.bound).toBe(false)
  })

  it('head: does not bind when neither sha nor patch identity match', () => {
    const judged = manifest({ headSha: 'b'.repeat(40) })
    const current = manifest({ headSha: 'c'.repeat(40) })
    const result = compareManifest(manifestAsEchoed(judged), current)
    expect(result.head).toBe(false)
    expect(result.bound).toBe(false)
  })

  it('objectivesVersion: a null current version skips the binding entirely', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), objectivesVersion: 'stale-version' }
    const current = manifest({ objectivesVersion: null })
    expect(compareManifest(echoed, current).objectivesVersion).toBe(true)
  })

  it('objectivesVersion: does not bind when the echoed version is stale against a real current one', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), objectivesVersion: 'a'.repeat(64) }
    const current = manifest({ objectivesVersion: 'b'.repeat(64) })
    expect(compareManifest(echoed, current).objectivesVersion).toBe(false)
  })

  it('rulingOrdinal: a null echo binds only when the current ordinal is 0', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), rulingOrdinal: null }
    expect(compareManifest(echoed, manifest({ rulingOrdinal: 0 })).rulingOrdinal).toBe(true)
    expect(compareManifest(echoed, manifest({ rulingOrdinal: 1 })).rulingOrdinal).toBe(false)
  })

  it('briefHash: a null current hash (no brief resolvable) skips the binding', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), briefHash: 'stale-hash' }
    expect(compareManifest(echoed, manifest({ briefHash: null })).briefHash).toBe(true)
  })

  it('briefHash: does not bind when the echoed hash is stale against a real current one', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), briefHash: briefHash('an old brief') }
    const current = manifest({ briefHash: briefHash('a superseding brief') })
    expect(compareManifest(echoed, current).briefHash).toBe(false)
  })

  it('policyDigest: a null echo (pre-cutover legacy comment) is NEVER grandfathered — unlike every other field, a policy is always resolvable so there is no genuine "nothing to bind against" case (#478 round 4, security MEDIUM)', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), policyDigest: null }
    const current = manifest({
      policyDigest: policyDigest({ codeReviewThreshold: 'MAJOR', securityThreshold: 'LOW', maxRounds: 3 })
    })
    expect(compareManifest(echoed, current).policyDigest).toBe(false)
  })

  it('policyDigest: does not bind when the echoed digest is stale against a changed current policy', () => {
    const echoed: EchoedManifest = {
      ...manifestAsEchoed(manifest()),
      policyDigest: policyDigest(DEFAULT_REVIEW_POLICY)
    }
    const current = manifest({
      policyDigest: policyDigest({ codeReviewThreshold: 'MAJOR', securityThreshold: 'LOW', maxRounds: 3 })
    })
    expect(compareManifest(echoed, current).policyDigest).toBe(false)
  })
})
