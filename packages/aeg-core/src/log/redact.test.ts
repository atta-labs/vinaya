import { describe, expect, it } from 'vitest'
import { redact } from './redact'

const HOME = '/Users/daniboomerang'

// Low-entropy, all-uppercase suffixes deliberately — a mixed-case/digit
// suffix here reads as a real credential to gitleaks' generic-api-key rule
// (verified: `ghp_abc123DEF456` tripped it in an earlier draft, commit
// `ded8a74e`; `ghp_ABCDEFGHIJKLMNOP` does not, matching the shape already
// accepted elsewhere in this repo, review-post.test.ts).
describe('redact', () => {
  it('rewrites a ghp_ token', () => {
    expect(redact('token=ghp_ABCDEFGHIJKLMNOP', HOME)).toBe('token=<redacted>')
  })

  it('rewrites a gho_ token', () => {
    expect(redact('gho_ABCDEFGHIJKLMNOPQRST', HOME)).toBe('<redacted>')
  })

  it('rewrites a github_pat_ token', () => {
    expect(redact('github_pat_ABCDEFGHIJ_XYZ', HOME)).toBe('<redacted>')
  })

  it('rewrites an Authorization: Bearer <token> value to <redacted>', () => {
    expect(redact('Authorization: Bearer ABCDEFGHIJKLMNOP', HOME)).toBe('Authorization: <redacted>')
  })

  it('rewrites a $HOME path to ~/…', () => {
    expect(redact(`${HOME}/Work/Repositories/vinaya`, HOME)).toBe('~/Work/Repositories/vinaya')
  })

  it('leaves other strings intact', () => {
    expect(redact('nothing sensitive here', HOME)).toBe('nothing sensitive here')
  })

  it('walks nested objects and arrays', () => {
    const input = { a: [`${HOME}/x`, 'ghp_ABCDEFGH'], b: { c: 'fine' } }
    expect(redact(input, HOME)).toEqual({ a: ['~/x', '<redacted>'], b: { c: 'fine' } })
  })

  it('leaves non-string leaves untouched', () => {
    expect(redact({ n: 1, b: true, u: null }, HOME)).toEqual({ n: 1, b: true, u: null })
  })
})
