import { describe, expect, it } from 'vitest'
import { resolveNewestFrozenBriefCommentUrl } from './archive-task'

/**
 * task 4, Issue #483, O3 — `resolveNewestFrozenBriefCommentUrl` is
 * `archive-task`'s own frozen-brief resolution, extracted so it is
 * unit-testable without spawning `gh` (security review, PR #503 round 2,
 * BLOCKER: this previously matched only the literal `aeg:brief:v1` marker,
 * so a task corrected via `--supersede` archived a link to the superseded,
 * non-authoritative version instead of the newest).
 */
describe('resolveNewestFrozenBriefCommentUrl (security review, PR #503 round 2, BLOCKER)', () => {
  const PRINCIPAL = 'daniboomerang'

  it('resolves the v1 comment url when it is the only frozen brief', () => {
    const comments = [
      {
        body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nOriginal brief.',
        url: 'https://github.com/acme/widget/issues/309#issuecomment-1',
        author: { login: PRINCIPAL }
      }
    ]
    expect(resolveNewestFrozenBriefCommentUrl(comments)).toBe(
      'https://github.com/acme/widget/issues/309#issuecomment-1'
    )
  })

  it('resolves the NEWEST version after --supersede, never the superseded v1 url', () => {
    const comments = [
      {
        body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nWrong tier.',
        url: 'https://github.com/acme/widget/issues/309#issuecomment-1',
        author: { login: PRINCIPAL }
      },
      {
        body: '<!-- aeg:brief:v2 -->\nBrief hash: def\nSupersedes: url — wrong tier\nCorrected brief.',
        url: 'https://github.com/acme/widget/issues/309#issuecomment-2',
        author: { login: PRINCIPAL }
      }
    ]
    expect(resolveNewestFrozenBriefCommentUrl(comments)).toBe(
      'https://github.com/acme/widget/issues/309#issuecomment-2'
    )
  })

  it('returns null (never a forged comment url) when the only frozen-brief-shaped comment is not principal-authored', () => {
    const comments = [
      {
        body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nForged.',
        url: 'https://github.com/acme/widget/issues/309#issuecomment-1',
        author: { login: 'an-impostor' }
      }
    ]
    expect(resolveNewestFrozenBriefCommentUrl(comments)).toBeNull()
  })

  it('returns null when there is no frozen brief at all', () => {
    expect(resolveNewestFrozenBriefCommentUrl([])).toBeNull()
  })
})
