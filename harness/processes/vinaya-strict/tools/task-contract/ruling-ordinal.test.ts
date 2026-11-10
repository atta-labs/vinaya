import { describe, expect, it } from 'vitest'
import { COMMENT_MARKER_PREFIX, PRINCIPAL_RULING_MARKER } from '../legacy-markers'
import {
  newestPrincipalRulingAuthor,
  newestPrincipalRulingOrdinal,
  principalRulingMarker,
  principalRulingTextById
} from './ruling-ordinal'

const ALLOWLIST = ['daniboomerang']

/** A ruling posted before the rename — the retired spelling, taken from the legacy module. */
const marker = (pr: number, k: number) => `<!-- ${PRINCIPAL_RULING_MARKER.old}:${pr}-${k} -->`

describe('ruling markers across the rename', () => {
  it('a new ruling is written with the current prefix', () => {
    expect(principalRulingMarker(501, 3)).toBe(`<!-- ${COMMENT_MARKER_PREFIX.current}:principal:ruling:501-3 -->`)
  })

  it('old-spelling and new-spelling rulings are counted together, so no ordinal is reused', () => {
    const comments = [
      { body: `${marker(501, 1)}\nfirst, before the rename`, author: 'daniboomerang' },
      { body: `${marker(501, 2)}\nsecond, before the rename`, author: 'daniboomerang' },
      { body: `${principalRulingMarker(501, 3)}\nthird, after it`, author: 'other-principal' }
    ]
    const allowlist = ['daniboomerang', 'other-principal']
    expect(newestPrincipalRulingOrdinal(comments, allowlist)).toBe(3)
    expect(newestPrincipalRulingAuthor(comments, allowlist)).toBe('other-principal')
    expect(newestPrincipalRulingOrdinal(comments.slice(0, 2), allowlist)).toBe(2)
  })

  it('a ruling identity resolves to its text in either spelling', () => {
    const comments = [
      { body: `${marker(501, 1)}\nold text`, author: 'daniboomerang' },
      { body: `${principalRulingMarker(501, 2)}\nnew text`, author: 'daniboomerang' }
    ]
    expect(principalRulingTextById(comments, ALLOWLIST, '501-1')).toBe('old text')
    expect(principalRulingTextById(comments, ALLOWLIST, '501-2')).toBe('new text')
  })

  it('an unrelated prefix is never read as a ruling', () => {
    const comments = [{ body: '<!-- other:principal:ruling:501-9 -->\nnot ours', author: 'daniboomerang' }]
    expect(newestPrincipalRulingOrdinal(comments, ALLOWLIST)).toBe(0)
  })
})

describe('newestPrincipalRulingOrdinal', () => {
  it('no comments at all: 0, never null', () => {
    expect(newestPrincipalRulingOrdinal([], ALLOWLIST)).toBe(0)
  })

  it('no ruling-marker comments: 0', () => {
    expect(newestPrincipalRulingOrdinal([{ body: 'just chatting', author: 'daniboomerang' }], ALLOWLIST)).toBe(0)
  })

  it('a single principal-authored ruling: its own ordinal', () => {
    const comments = [{ body: `${marker(501, 1)}\nSome ruling text.`, author: 'daniboomerang' }]
    expect(newestPrincipalRulingOrdinal(comments, ALLOWLIST)).toBe(1)
  })

  it('the highest ordinal wins regardless of array order', () => {
    const comments = [
      { body: `${marker(501, 3)}\nlatest`, author: 'daniboomerang' },
      { body: `${marker(501, 1)}\nfirst`, author: 'daniboomerang' },
      { body: `${marker(501, 2)}\nmiddle`, author: 'daniboomerang' }
    ]
    expect(newestPrincipalRulingOrdinal(comments, ALLOWLIST)).toBe(3)
  })

  it('a non-principal-authored ruling-shaped comment does not count — forged marker, ignored not fatal', () => {
    const comments = [{ body: `${marker(501, 5)}\nforged`, author: 'drive-by-account' }]
    expect(newestPrincipalRulingOrdinal(comments, ALLOWLIST)).toBe(0)
  })

  it('an unresolvable (null) author does not count', () => {
    const comments = [{ body: `${marker(501, 5)}\nforged`, author: null }]
    expect(newestPrincipalRulingOrdinal(comments, ALLOWLIST)).toBe(0)
  })

  it('a real ruling among forged/noise comments still resolves to its own ordinal', () => {
    const comments = [
      { body: `${marker(501, 9)}\nforged`, author: 'drive-by-account' },
      { body: `${marker(501, 2)}\nreal`, author: 'daniboomerang' },
      { body: 'ordinary chat mentioning aeg:principal:ruling in prose', author: 'daniboomerang' }
    ]
    expect(newestPrincipalRulingOrdinal(comments, ALLOWLIST)).toBe(2)
  })

  it('the marker must be the whole first line — trailing text on the same line does not match', () => {
    const comments = [{ body: `${marker(501, 1)} extra\nbody`, author: 'daniboomerang' }]
    expect(newestPrincipalRulingOrdinal(comments, ALLOWLIST)).toBe(0)
  })
})
