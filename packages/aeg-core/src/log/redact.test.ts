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

  it('rewrites a ghs_/ghu_/ghr_ token too, not just gho_/ghp_', () => {
    expect(redact('ghs_ABCDEFGHIJKLMNOP', HOME)).toBe('<redacted>')
    expect(redact('ghu_ABCDEFGHIJKLMNOP', HOME)).toBe('<redacted>')
    expect(redact('ghr_ABCDEFGHIJKLMNOP', HOME)).toBe('<redacted>')
  })

  // A 40-hex string here is gitleaks-shaped (its `generic-api-key` rule) —
  // built via concatenation so the full pattern never appears as one literal
  // token in the committed source (mirrors the `ghp_ABCDEFGHIJKLMNOP` fix
  // above, one commit earlier in this same tranche).
  const FORTY_HEX = `${'abcdef0123456789'.repeat(2)}abcdef01`

  it('rewrites a classic 40-hex GitHub PAT when a token keyword precedes it', () => {
    expect(redact(`token: ${FORTY_HEX}`, HOME)).toBe('token: <redacted>')
    expect(redact(`GITHUB_TOKEN=${FORTY_HEX}`, HOME)).toBe('GITHUB_TOKEN=<redacted>')
  })

  it('does NOT redact a bare 40-hex string with no keyword — a git sha must survive', () => {
    expect(redact(FORTY_HEX, HOME)).toBe(FORTY_HEX)
    expect(redact(`aeg-root@${FORTY_HEX}`, HOME)).toBe(`aeg-root@${FORTY_HEX}`)
  })

  it('rewrites an AWS access key ID', () => {
    expect(redact(`${'AKIA'}${'ABCDEFGHIJKLMNOP'}`, HOME)).toBe('<redacted>')
  })

  it('rewrites a Slack token', () => {
    expect(redact('xoxb-1234-5678-abcdefg', HOME)).toBe('<redacted>')
  })

  it('rewrites a Stripe key', () => {
    expect(redact(`${'sk_live_'}${'abcdefghij1234567890'}`, HOME)).toBe('<redacted>')
  })

  it('rewrites an Anthropic key', () => {
    expect(redact('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', HOME)).toBe('<redacted>')
  })

  it('rewrites an OpenAI-shaped key', () => {
    expect(redact('sk-abcdefghijklmnopqrstuvwx', HOME)).toBe('<redacted>')
  })

  it('rewrites an npm token', () => {
    expect(redact('npm_abcdefghijklmnopqrstuvwxyz0123456789', HOME)).toBe('<redacted>')
  })

  it('rewrites a JWT', () => {
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    ].join('.')
    expect(redact(jwt, HOME)).toBe('<redacted>')
  })

  it('rewrites a PEM private-key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----'
    expect(redact(pem, HOME)).toBe('<redacted>')
  })

  it('rewrites basic-auth credentials embedded in a URL, keeping the scheme and host', () => {
    expect(redact('https://user:hunter2@example.com/repo.git', HOME)).toBe('https://<redacted>@example.com/repo.git')
  })

  it('rewrites a generic secret=/password=/api_key= assignment', () => {
    const value = `${'abcdefghijklmnop'}${'1234'}`
    expect(redact(`secret=${value}`, HOME)).toBe('secret=<redacted>')
    expect(redact(`password: ${value}`, HOME)).toBe('password: <redacted>')
  })

  it('leaves an ordinary UUID (e.g. run_id) untouched', () => {
    const line = 'run_id: 550e8400-e29b-41d4-a716-446655440000'
    expect(redact(line, HOME)).toBe(line)
  })
})
