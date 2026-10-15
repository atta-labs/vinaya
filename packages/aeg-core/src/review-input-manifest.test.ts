import { describe, expect, it } from 'vitest'
import {
  briefHash,
  buildReviewInputManifest,
  compareManifest,
  manifestAsEchoed,
  pauseBoundRulingDigest,
  pauseBoundRulingFromResolution,
  policyDigest,
  type EchoedManifest,
  type ReviewInputManifest
} from './review-input-manifest'
import { DEFAULT_REVIEW_POLICY } from './review-policy'
import { principalRulingTextById } from './ruling-ordinal'

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
    const a = policyDigest({
      codeReviewThreshold: 'BLOCKER',
      securityThreshold: 'HIGH',
      maxRounds: 3,
      maxTaskMinutes: 180
    })
    const b = policyDigest({
      codeReviewThreshold: 'MAJOR',
      securityThreshold: 'HIGH',
      maxRounds: 3,
      maxTaskMinutes: 180
    })
    const c = policyDigest({
      codeReviewThreshold: 'BLOCKER',
      securityThreshold: 'LOW',
      maxRounds: 3,
      maxTaskMinutes: 180
    })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a).toBe(
      policyDigest({ codeReviewThreshold: 'BLOCKER', securityThreshold: 'HIGH', maxRounds: 3, maxTaskMinutes: 180 })
    )
  })

  it('policyDigest ignores the round cap — two policies differing only in maxRounds share one digest (#874, O1)', () => {
    const three = policyDigest({
      codeReviewThreshold: 'BLOCKER',
      securityThreshold: 'HIGH',
      maxRounds: 3,
      maxTaskMinutes: 180
    })
    const five = policyDigest({
      codeReviewThreshold: 'BLOCKER',
      securityThreshold: 'HIGH',
      maxRounds: 5,
      maxTaskMinutes: 180
    })
    expect(three).toBe(five)
  })

  it("policyDigest ignores the task's time budget — a changed budget never moves the digest (#874, O1)", () => {
    const base = { codeReviewThreshold: 'BLOCKER', securityThreshold: 'HIGH', maxRounds: 3 } as const
    const threeHours = policyDigest({ ...base, maxTaskMinutes: 180 })
    const oneHour = policyDigest({ ...base, maxTaskMinutes: 60 })
    const off = policyDigest({ ...base, maxTaskMinutes: 0 })
    expect(threeHours).toBe(oneHour)
    expect(threeHours).toBe(off)
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
      pauseBoundRuling: true,
      manifestVersion: true,
      policyDigest: true
    })
  })

  it('refuses a verdict whose pause-bound Principal ruling differs', () => {
    const current = manifest({
      manifestVersion: 2,
      pauseBoundRuling: { rulingId: '601-2', pauseId: 'pause-1', contentDigest: 'a'.repeat(64) }
    })
    const echoed = manifestAsEchoed(current)
    echoed.pauseBoundRuling = { rulingId: '601-2', pauseId: 'pause-1', contentDigest: 'b'.repeat(64) }
    expect(compareManifest(echoed, current).bound).toBe(false)
    expect(compareManifest(echoed, current).pauseBoundRuling).toBe(false)
  })

  it('refuses an unknown manifest protocol version', () => {
    const current = manifest({ manifestVersion: 2 })
    const echoed = { ...manifestAsEchoed(current), manifestVersion: 99 }
    expect(compareManifest(echoed, current).bound).toBe(false)
    expect(compareManifest(echoed, current).manifestVersion).toBe(false)
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

  it('base: a base-only change (identical candidate, moved base) is tolerated (#680, O1)', () => {
    // Exact head match, and the base moved under it. A verdict judges the
    // pull request; the base is still recorded for audit, but moving it alone
    // does not invalidate. CI at the new head is the guard for any semantic
    // conflict a base move could hide.
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), baseSha: 'd'.repeat(40) }
    const current = manifest({ baseSha: 'e'.repeat(40) })
    const result = compareManifest(echoed, current)
    expect(result.head).toBe(true)
    expect(result.base).toBe(true)
    expect(result.bound).toBe(true)
  })

  it('base: a base-only change is tolerated even when a real patchIdOf is wired in (#680, O1)', () => {
    // The exact production configuration `check-review-gate.ts` always
    // uses: patchIdOf is a real function, never undefined. Calling it with
    // the SAME sha on both sides (an unchanged head) must never be read as
    // "a proven rebase" — a deterministic patchIdOf trivially agrees with
    // itself, which is not evidence of anything. What matters is the exact
    // head match itself: when the candidate head binds exactly, a moved base
    // is tolerated.
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), baseSha: 'd'.repeat(40) }
    const current = manifest({ baseSha: 'e'.repeat(40) })
    const patchIdOf = (sha: string) => `patch-for-${sha}`
    const result = compareManifest(echoed, current, patchIdOf)
    expect(result.head).toBe(true)
    expect(result.base).toBe(true)
    expect(result.bound).toBe(true)
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

  it('base: a correctly-abbreviated echo binds against the real full-length current base (#603 round 2, F2) — the same tolerance isBoundToHead already gives an abbreviated head', () => {
    const abbreviated = BASE.slice(0, 12)
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), baseSha: abbreviated }
    const current = manifest({ baseSha: BASE })
    const result = compareManifest(echoed, current)
    expect(result.base).toBe(true)
    expect(result.bound).toBe(true)
  })

  it('base: an abbreviated echo that does not prefix the real current base still refuses', () => {
    const echoed: EchoedManifest = { ...manifestAsEchoed(manifest()), baseSha: 'd'.repeat(7) }
    const current = manifest({ baseSha: BASE })
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
      policyDigest: policyDigest({
        codeReviewThreshold: 'MAJOR',
        securityThreshold: 'LOW',
        maxRounds: 3,
        maxTaskMinutes: 180
      })
    })
    expect(compareManifest(echoed, current).policyDigest).toBe(false)
  })

  it('policyDigest: does not bind when the echoed digest is stale against a changed current policy', () => {
    const echoed: EchoedManifest = {
      ...manifestAsEchoed(manifest()),
      policyDigest: policyDigest(DEFAULT_REVIEW_POLICY)
    }
    const current = manifest({
      policyDigest: policyDigest({
        codeReviewThreshold: 'MAJOR',
        securityThreshold: 'LOW',
        maxRounds: 3,
        maxTaskMinutes: 180
      })
    })
    expect(compareManifest(echoed, current).policyDigest).toBe(false)
  })
})

describe('pauseBoundRulingFromResolution — the slot comes from the consumed resolution alone', () => {
  const allowlist = ['principal']
  const ruling = (ref: number, k: number, text: string) => ({
    body: `<!-- aeg:principal:ruling:${ref}-${k} -->\n${text}\n`,
    author: 'principal'
  })
  const resolution = {
    escalationId: 'esc-7',
    decision: 'resume' as const,
    authenticatedBy: 'principal',
    authenticatedFrom: '42-2'
  }

  it('digests the ruling carrying exactly the consumed marker, whatever the comment order', () => {
    const comments = [ruling(42, 3, 'third'), ruling(42, 2, 'second'), ruling(42, 1, 'first')]
    const slot = pauseBoundRulingFromResolution(resolution, (id) => principalRulingTextById(comments, allowlist, id))
    expect(slot).toEqual({ rulingId: '42-2', pauseId: 'esc-7', contentDigest: pauseBoundRulingDigest('second') })
  })

  it('refuses rather than binding a lone newer ruling to the consumed identity', () => {
    const comments = [ruling(42, 3, 'newer ruling')]
    expect(() =>
      pauseBoundRulingFromResolution(resolution, (id) => principalRulingTextById(comments, allowlist, id))
    ).toThrow('no single principal ruling comment carries that ruling identity')
  })

  it('refuses an identity two principal comments both carry', () => {
    const comments = [ruling(42, 2, 'one'), ruling(42, 2, 'two')]
    expect(principalRulingTextById(comments, allowlist, '42-2')).toBeNull()
  })

  it('ignores a matching marker from a non-principal author', () => {
    const comments = [{ ...ruling(42, 2, 'forged'), author: 'someone-else' }]
    expect(principalRulingTextById(comments, allowlist, '42-2')).toBeNull()
  })

  it('reads an Issue ruling identity against the Issue marker', () => {
    expect(principalRulingTextById([ruling(9, 1, 'issue ruling')], allowlist, 'issue-9-1')).toBe('issue ruling')
  })

  it('is explicitly empty for a self-recovery or a resolution that names no ruling', () => {
    const read = () => {
      throw new Error('no ruling should be read')
    }
    expect(pauseBoundRulingFromResolution(null, read)).toBeNull()
    expect(
      pauseBoundRulingFromResolution(
        { ...resolution, authenticatedBy: 'driver-self', authenticatedFrom: '42-infrastructure-retry' },
        read
      )
    ).toBeNull()
    expect(
      pauseBoundRulingFromResolution(
        { ...resolution, authenticatedFrom: 'widen-surface:https://example.test/c/1' },
        read
      )
    ).toBeNull()
    expect(pauseBoundRulingFromResolution({ ...resolution, decision: 'cancel' }, read)).toBeNull()
  })
})
