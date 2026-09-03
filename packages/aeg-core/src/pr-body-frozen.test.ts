import { describe, expect, it } from 'vitest'
import {
  authoredRegion,
  authoredRegionHash,
  checkPrBodyFrozen,
  FROZEN_BODY_SINCE_PR,
  renderBodyHashMarker
} from './pr-body-frozen'

const PRINCIPALS = ['daniboomerang']
const BEFORE_ROLLOUT_PR = FROZEN_BODY_SINCE_PR - 1
const AFTER_ROLLOUT_PR = FROZEN_BODY_SINCE_PR

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

function withMarkerComment(hash: string, author = 'daniboomerang', createdAt = '2026-09-03T00:00:00Z') {
  return [{ body: renderBodyHashMarker(hash), author, createdAt }]
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
    // Trailing newline stripped too — the trailing-whitespace normalisation
    // this same function applies (round-2 ruling addendum 3).
    expect(authoredRegion(unanchored)).toBe(
      'Notes:\n- [ ] **[principal]** done outside the anchored Test Plan section.'
    )
  })

  it('a body with an appended AEG:TOKENS row hashes equal to the body without it', () => {
    const withoutRow = BASE_BODY.replace(
      '| 5: develop | Developer | Sonnet 5 | 1000 | 500 | \\$0.10 | 2026-09-03 |\n',
      ''
    )
    expect(authoredRegionHash(BASE_BODY)).toBe(authoredRegionHash(withoutRow))
  })

  it('hashes identically with and without a trailing newline, and with CRLF (round-2 ruling addendum 3)', () => {
    // `vinaya pr create --body-file` hashes the file as written (trailing
    // newline included); the live PR body GitHub's webhook returns has no
    // trailing newline. Same authored bytes, different hash — #393.
    const withoutTrailingNewline = BASE_BODY.replace(/\n+$/, '')
    const withCrlf = BASE_BODY.replace(/\n/g, '\r\n')
    const hash = authoredRegionHash(BASE_BODY)
    expect(authoredRegionHash(withoutTrailingNewline)).toBe(hash)
    expect(authoredRegionHash(withCrlf)).toBe(hash)
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
      prNumber: AFTER_ROLLOUT_PR
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
      prNumber: AFTER_ROLLOUT_PR
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
      prNumber: AFTER_ROLLOUT_PR
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
      prNumber: AFTER_ROLLOUT_PR
    })
    expect(result.status).toBe('fail')
    expect(result.errors.join('\n')).toContain('authored region no longer matches')
  })

  it('is info (grandfathered) when no marker comment exists on a pre-rollout PR number', () => {
    const result = checkPrBodyFrozen({
      body: BASE_BODY,
      comments: [],
      principalAllowlist: PRINCIPALS,
      prNumber: BEFORE_ROLLOUT_PR
    })
    expect(result.status).toBe('info')
  })

  it('fails, not grandfathered, when no marker comment exists on a PR numbered at or above FROZEN_BODY_SINCE_PR — the same shape a deleted marker comment presents (checkPrBodyFrozen cannot distinguish "never posted" from "posted then deleted"; both are zero matching comments, which is exactly why grandfathering is keyed to PR number, not marker absence)', () => {
    const result = checkPrBodyFrozen({
      body: BASE_BODY,
      comments: [],
      principalAllowlist: PRINCIPALS,
      prNumber: AFTER_ROLLOUT_PR
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
      prNumber: BEFORE_ROLLOUT_PR
    })
    expect(result.status).toBe('info')
  })

  it('a marker from a non-allowlisted author on a post-rollout PR fails rather than passing', () => {
    const hash = authoredRegionHash(BASE_BODY)
    const result = checkPrBodyFrozen({
      body: BASE_BODY,
      comments: withMarkerComment(hash, 'attacker'),
      principalAllowlist: PRINCIPALS,
      prNumber: AFTER_ROLLOUT_PR
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
      prNumber: AFTER_ROLLOUT_PR
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
      prNumber: AFTER_ROLLOUT_PR
    })
    expect(result.status).toBe('pass')
  })

  it('the EARLIEST allowlisted marker wins — a later repost never overrides the open-time hash', () => {
    const openTimeHash = authoredRegionHash(BASE_BODY)
    const edited = BASE_BODY.replace('Touches aeg-core and cli.', 'Touches aeg-core and cli. Also touches sources.')
    const laterHash = authoredRegionHash(edited)
    const comments = [
      { body: renderBodyHashMarker(laterHash), author: 'daniboomerang', createdAt: '2026-09-03T05:00:00Z' },
      { body: renderBodyHashMarker(openTimeHash), author: 'daniboomerang', createdAt: '2026-09-03T01:00:00Z' }
    ]
    // Array order deliberately does NOT match createdAt order — the function
    // must sort by createdAt, never trust array position.
    const passResult = checkPrBodyFrozen({
      body: BASE_BODY,
      comments,
      principalAllowlist: PRINCIPALS,
      prNumber: AFTER_ROLLOUT_PR
    })
    expect(passResult.status).toBe('pass')

    const failResult = checkPrBodyFrozen({
      body: edited,
      comments,
      principalAllowlist: PRINCIPALS,
      prNumber: AFTER_ROLLOUT_PR
    })
    expect(failResult.status).toBe('fail')
  })

  it('a later, non-allowlisted marker never displaces an earlier allowlisted one', () => {
    const openTimeHash = authoredRegionHash(BASE_BODY)
    const attackerHash = authoredRegionHash(
      BASE_BODY.replace('Touches aeg-core and cli.', 'Touches aeg-core and cli. Also touches sources.')
    )
    const comments = [
      { body: renderBodyHashMarker(openTimeHash), author: 'daniboomerang', createdAt: '2026-09-03T01:00:00Z' },
      { body: renderBodyHashMarker(attackerHash), author: 'attacker', createdAt: '2026-09-03T02:00:00Z' }
    ]
    const result = checkPrBodyFrozen({
      body: BASE_BODY,
      comments,
      principalAllowlist: PRINCIPALS,
      prNumber: AFTER_ROLLOUT_PR
    })
    expect(result.status).toBe('pass')
  })
})
