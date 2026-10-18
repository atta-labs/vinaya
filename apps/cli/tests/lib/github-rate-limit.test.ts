import { describe, expect, it } from 'bun:test'
import {
  execErrorText,
  formatResetUtc,
  isGithubRateLimitError,
  rateLimitBudget,
  rateLimitMessage,
  readRateLimitReset
} from '../../src/lib/github-rate-limit'

// 2026-10-18T14:05:00Z
const RESET = Date.UTC(2026, 9, 18, 14, 5, 0) / 1000

function reply(graphql: { remaining: number; reset: number }, core: { remaining: number; reset: number }): string {
  return JSON.stringify({
    resources: {
      core: { limit: 5000, used: 5000 - core.remaining, ...core },
      graphql: { limit: 5000, used: 5000 - graphql.remaining, ...graphql }
    }
  })
}

describe('isGithubRateLimitError', () => {
  it("matches GitHub's primary and secondary rate-limit wording", () => {
    expect(isGithubRateLimitError('GraphQL: API rate limit exceeded for user ID 1234567.')).toBe(true)
    expect(isGithubRateLimitError('HTTP 403: API rate limit exceeded for 203.0.113.7.')).toBe(true)
    expect(isGithubRateLimitError('API rate limit already exceeded for user ID 1.')).toBe(true)
    expect(isGithubRateLimitError('You have exceeded a secondary rate limit. Please wait a few minutes.')).toBe(true)
  })

  it('does not match an error that merely mentions GitHub', () => {
    expect(isGithubRateLimitError('error connecting to api.github.com')).toBe(false)
    expect(isGithubRateLimitError('HTTP 401: Bad credentials (https://api.github.com/graphql)')).toBe(false)
    expect(isGithubRateLimitError('GraphQL: Could not resolve to an issue or pull request with the number of 9.')).toBe(
      false
    )
  })
})

describe('rateLimitBudget', () => {
  it('is GraphQL when the error begins `GraphQL:`, otherwise REST', () => {
    expect(rateLimitBudget('GraphQL: API rate limit exceeded for user ID 1.')).toBe('GraphQL')
    expect(rateLimitBudget('  GraphQL: API rate limit exceeded')).toBe('GraphQL')
    expect(rateLimitBudget('HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/x)')).toBe('REST')
    expect(rateLimitBudget('error: GraphQL: API rate limit exceeded')).toBe('REST')
  })
})

describe('readRateLimitReset', () => {
  it("reads the named budget's own reset", () => {
    const r = reply({ remaining: 0, reset: RESET }, { remaining: 0, reset: RESET + 600 })
    expect(readRateLimitReset('GraphQL', () => r)).toBe(RESET)
    expect(readRateLimitReset('REST', () => r)).toBe(RESET + 600)
  })

  it('is null when that budget still has calls left — the refusal was a secondary limit', () => {
    const r = reply({ remaining: 4000, reset: RESET }, { remaining: 0, reset: RESET })
    expect(readRateLimitReset('GraphQL', () => r)).toBeNull()
  })

  it('is null when the read fails or the reply carries no reset', () => {
    expect(
      readRateLimitReset('REST', () => {
        throw new Error('gh: rate_limit read failed')
      })
    ).toBeNull()
    expect(readRateLimitReset('REST', () => 'not json')).toBeNull()
    expect(readRateLimitReset('REST', () => JSON.stringify({ resources: {} }))).toBeNull()
  })
})

describe('formatResetUtc', () => {
  it('formats epoch seconds as zero-padded HH:MM UTC', () => {
    expect(formatResetUtc(RESET)).toBe('14:05 UTC')
    expect(formatResetUtc(Date.UTC(2026, 0, 1, 3, 7, 59) / 1000)).toBe('03:07 UTC')
  })
})

describe('rateLimitMessage', () => {
  it('names the budget and its reset time', () => {
    const r = reply({ remaining: 0, reset: RESET }, { remaining: 5000, reset: RESET + 3600 })
    expect(rateLimitMessage('GraphQL: API rate limit exceeded for user ID 1.', () => r)).toBe(
      'GitHub rate limit (GraphQL), resets at 14:05 UTC'
    )
  })

  it('says "resets in a few minutes" when no reset is reported', () => {
    expect(
      rateLimitMessage('HTTP 403: You have exceeded a secondary rate limit.', () => {
        throw new Error('must not be read for a secondary limit')
      })
    ).toBe('GitHub rate limit (REST), resets in a few minutes')
    expect(rateLimitMessage('HTTP 403: API rate limit exceeded', () => 'not json')).toBe(
      'GitHub rate limit (REST), resets in a few minutes'
    )
  })
})

describe('execErrorText', () => {
  it("puts a failed call's stderr first, so its `GraphQL:` prefix stays at the start", () => {
    const err = Object.assign(new Error('Command failed: gh pr list'), { stderr: 'GraphQL: API rate limit exceeded\n' })
    expect(rateLimitBudget(execErrorText(err))).toBe('GraphQL')
    expect(execErrorText(new Error('spawn gh ENOENT'))).toBe('spawn gh ENOENT')
  })
})
