import { describe, expect, it } from 'vitest'
import { newestPrincipalRulingOrdinal } from './ruling-ordinal'

const ALLOWLIST = ['daniboomerang']

const marker = (pr: number, k: number) => `<!-- aeg:principal:ruling:${pr}-${k} -->`

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
