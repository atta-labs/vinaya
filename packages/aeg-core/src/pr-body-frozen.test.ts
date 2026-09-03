import { describe, expect, it } from 'vitest'
import {
  authoredRegion,
  authoredRegionHash,
  checkPrBodyFrozen,
  FROZEN_BODY_SINCE,
  renderBodyHashMarker
} from './pr-body-frozen'

const PRINCIPALS = ['daniboomerang']
const BEFORE_ROLLOUT = '2026-01-01T00:00:00Z'
const AFTER_ROLLOUT = `${FROZEN_BODY_SINCE}T12:00:00Z`

const BASE_BODY = `<!-- AEG:CLOSES:START -->
Closes #378
<!-- AEG:CLOSES:END -->

**For:** Sonnet 5
<!-- AEG:PROJECT:START -->
**Project:** aeg-core, cli
<!-- AEG:PROJECT:END -->

## Summary

Ships the pr-body-frozen check.

## Test plan

<!-- AEG:TEST-PLAN:START -->
- [ ] **[agent]** \`bun test\` passes.
- [ ] **[principal]** Ticks after browser verification.
<!-- AEG:TEST-PLAN:END -->

## Evidence

<!-- AEG:EVIDENCE:START -->
Head: abc123
\`\`\`
2 files changed
\`\`\`
<!-- AEG:EVIDENCE:END -->

## Scope

Touches aeg-core and cli.

<!-- AEG:TIER:START -->
**Tier:** 1
<!-- AEG:TIER:END -->

## Token report

<!-- AEG:TOKENS:START -->
| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |
|---|---|---|---|---|---|---|
| 5: develop | Developer | Sonnet 5 | 1000 | 500 | \\$0.10 | 2026-09-03 |
<!-- AEG:TOKENS:END -->
`

function withMarkerComment(hash: string, author = 'daniboomerang') {
  return [{ body: renderBodyHashMarker(hash), author }]
}

describe('authoredRegion', () => {
  it('strips every ANCHOR_FIELDS region', () => {
    const region = authoredRegion(BASE_BODY)
    expect(region).not.toContain('Closes #378')
    expect(region).not.toContain('Head: abc123')
    expect(region).not.toContain('1000')
    expect(region).not.toContain('[agent]')
  })

  it('normalises a ticked checkbox outside any anchored field to unticked', () => {
    const unanchored = 'Notes:\n- [x] **[principal]** done outside the anchored Test Plan section.\n'
    expect(authoredRegion(unanchored)).toBe(
      'Notes:\n- [ ] **[principal]** done outside the anchored Test Plan section.\n'
    )
  })

  it('a body with an appended AEG:TOKENS row hashes equal to the body without it', () => {
    const withoutRow = BASE_BODY.replace(
      '| 5: develop | Developer | Sonnet 5 | 1000 | 500 | \\$0.10 | 2026-09-03 |\n',
      ''
    )
    expect(authoredRegionHash(BASE_BODY)).toBe(authoredRegionHash(withoutRow))
  })
})

describe('checkPrBodyFrozen', () => {
  it('passes when the authored region is unchanged but the Evidence block was regenerated', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const regenerated = BASE_BODY.replace('Head: abc123', 'Head: def456')
    const result = checkPrBodyFrozen({
      body: regenerated,
      comments: withMarkerComment(hash),
      principalAllowlist: PRINCIPALS,
      createdAt: AFTER_ROLLOUT
    })
    expect(result.status).toBe('pass')
  })

  it('passes when a [principal] box has been ticked', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const ticked = BASE_BODY.replace('- [ ] **[principal]**', '- [x] **[principal]**')
    const result = checkPrBodyFrozen({
      body: ticked,
      comments: withMarkerComment(hash),
      principalAllowlist: PRINCIPALS,
      createdAt: AFTER_ROLLOUT
    })
    expect(result.status).toBe('pass')
  })

  it('passes when a re-entry appended a new AEG:TOKENS row', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const appended = BASE_BODY.replace(
      '<!-- AEG:TOKENS:END -->',
      '| 5: develop | Developer | Sonnet 5 | 200 | 100 | \\$0.02 | 2026-09-04 |\n<!-- AEG:TOKENS:END -->'
    )
    const result = checkPrBodyFrozen({
      body: appended,
      comments: withMarkerComment(hash),
      principalAllowlist: PRINCIPALS,
      createdAt: AFTER_ROLLOUT
    })
    expect(result.status).toBe('pass')
  })

  it('fails when a sentence is added to Scope', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const edited = BASE_BODY.replace('Touches aeg-core and cli.', 'Touches aeg-core and cli. Also touches sources.')
    const result = checkPrBodyFrozen({
      body: edited,
      comments: withMarkerComment(hash),
      principalAllowlist: PRINCIPALS,
      createdAt: AFTER_ROLLOUT
    })
    expect(result.status).toBe('fail')
    expect(result.errors.join('\n')).toContain('authored region no longer matches')
  })

  it('is info (grandfathered) when no marker comment exists on a pre-rollout PR', () => {
    const result = checkPrBodyFrozen({
      body: BASE_BODY,
      comments: [],
      principalAllowlist: PRINCIPALS,
      createdAt: BEFORE_ROLLOUT
    })
    expect(result.status).toBe('info')
  })

  it('fails, not grandfathered, when no marker comment exists on a PR created on or after FROZEN_BODY_SINCE — the same shape a deleted marker comment presents (checkPrBodyFrozen cannot distinguish "never posted" from "posted then deleted"; both are zero matching comments, which is exactly why grandfathering is keyed to creation date, not marker absence)', () => {
    const result = checkPrBodyFrozen({
      body: BASE_BODY,
      comments: [],
      principalAllowlist: PRINCIPALS,
      createdAt: AFTER_ROLLOUT
    })
    expect(result.status).toBe('fail')
    if (result.status === 'fail') expect(result.reason).toBe('no-marker-not-grandfathered')
  })

  it('ignores a marker comment from a non-allowlisted author on a pre-rollout PR (falls back to grandfathered info)', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const edited = BASE_BODY.replace('Touches aeg-core and cli.', 'Touches aeg-core and cli. Also touches sources.')
    const result = checkPrBodyFrozen({
      body: edited,
      comments: withMarkerComment(hash, 'attacker'),
      principalAllowlist: PRINCIPALS,
      createdAt: BEFORE_ROLLOUT
    })
    expect(result.status).toBe('info')
  })

  it('a marker from a non-allowlisted author on a post-rollout PR fails rather than passing', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const result = checkPrBodyFrozen({
      body: BASE_BODY,
      comments: withMarkerComment(hash, 'attacker'),
      principalAllowlist: PRINCIPALS,
      createdAt: AFTER_ROLLOUT
    })
    expect(result.status).toBe('fail')
    if (result.status === 'fail') expect(result.reason).toBe('no-marker-not-grandfathered')
  })

  it('tags a body mismatch with reason "mismatch"', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const edited = BASE_BODY.replace('Touches aeg-core and cli.', 'Touches aeg-core and cli. Also touches sources.')
    const result = checkPrBodyFrozen({
      body: edited,
      comments: withMarkerComment(hash),
      principalAllowlist: PRINCIPALS,
      createdAt: AFTER_ROLLOUT
    })
    expect(result.status).toBe('fail')
    if (result.status === 'fail') expect(result.reason).toBe('mismatch')
  })

  it('accepts a marker comment whose author case differs from the allowlist entry', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const result = checkPrBodyFrozen({
      body: BASE_BODY,
      comments: withMarkerComment(hash, 'DaniBoomerang'),
      principalAllowlist: PRINCIPALS,
      createdAt: AFTER_ROLLOUT
    })
    expect(result.status).toBe('pass')
  })
})
