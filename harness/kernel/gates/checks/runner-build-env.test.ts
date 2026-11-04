import { describe, expect, it } from 'bun:test'
import { buildCheckEnv } from './runner'

describe('buildCheckEnv', () => {
  const BASELINE_CALLER_ENV = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    HOME: '/home/tester',
    HTTPS_PROXY: 'http://proxy:8080',
    HTTP_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost',
    TMPDIR: '/tmp'
  }

  it('always forwards the baseline keys present in the caller env, with no declarations', () => {
    const out = buildCheckEnv(undefined, BASELINE_CALLER_ENV)
    expect(out).toEqual(BASELINE_CALLER_ENV)
  })

  it('never fabricates a baseline key the caller env does not have', () => {
    const out = buildCheckEnv(undefined, { PATH: '/usr/bin' })
    expect(out).toEqual({ PATH: '/usr/bin' })
  })

  it('`true` forwards the caller value for that exact key when set', () => {
    const out = buildCheckEnv({ AEG_REPO: true }, { ...BASELINE_CALLER_ENV, AEG_REPO: 'owner/repo' })
    expect(out.AEG_REPO).toBe('owner/repo')
  })

  it('`true` omits the key entirely when the caller does not have it set', () => {
    const out = buildCheckEnv({ AEG_REPO: true }, BASELINE_CALLER_ENV)
    expect('AEG_REPO' in out).toBe(false)
  })

  it('`{ optional: true }` forwards the caller value when set', () => {
    const out = buildCheckEnv({ PR_BODY: { optional: true } }, { ...BASELINE_CALLER_ENV, PR_BODY: 'body text' })
    expect(out.PR_BODY).toBe('body text')
  })

  it('`{ optional: true }` omits the key when the caller does not have it set — the documented zero-coverage case', () => {
    const out = buildCheckEnv({ PR_BODY: { optional: true } }, BASELINE_CALLER_ENV)
    expect('PR_BODY' in out).toBe(false)
  })

  it('a literal string sets the key to that exact value, ignoring the caller env entirely', () => {
    const out = buildCheckEnv(
      { NODE_ENV: 'production' },
      { ...BASELINE_CALLER_ENV, NODE_ENV: 'this-caller-value-is-ignored' }
    )
    expect(out.NODE_ENV).toBe('production')
  })

  it('a literal string is never interpolated — "$PATH" stays four literal characters', () => {
    const out = buildCheckEnv({ SOME_VAR: '$PATH' }, BASELINE_CALLER_ENV)
    expect(out.SOME_VAR).toBe('$PATH')
  })

  it('anyOf forwards each member under its OWN name when the caller has it set', () => {
    const out = buildCheckEnv(
      { GITHUB_TOKEN: { anyOf: ['GITHUB_TOKEN', 'GH_TOKEN'] } },
      { ...BASELINE_CALLER_ENV, GH_TOKEN: 'gh-token-value' }
    )
    expect(out.GH_TOKEN).toBe('gh-token-value')
    expect('GITHUB_TOKEN' in out).toBe(false)
  })

  it('anyOf forwards every set member simultaneously, not just the first', () => {
    const out = buildCheckEnv(
      { GITHUB_TOKEN: { anyOf: ['GITHUB_TOKEN', 'GH_TOKEN'] } },
      { ...BASELINE_CALLER_ENV, GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }
    )
    expect(out.GITHUB_TOKEN).toBe('a')
    expect(out.GH_TOKEN).toBe('b')
  })

  it('a declared entry OVERRIDES a baseline key value rather than being ignored', () => {
    const out = buildCheckEnv({ PATH: '/custom/bin' }, BASELINE_CALLER_ENV)
    expect(out.PATH).toBe('/custom/bin')
  })

  it('a declared entry never REMOVES a baseline key not itself declared', () => {
    const out = buildCheckEnv({ PATH: '/custom/bin' }, BASELINE_CALLER_ENV)
    expect(out.HOME).toBe(BASELINE_CALLER_ENV.HOME)
    expect(out.LANG).toBe(BASELINE_CALLER_ENV.LANG)
  })
})
