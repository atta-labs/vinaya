/**
 * github-rate-limit.ts — recognise a GitHub rate-limit refusal in a `gh`
 * error and say when it lifts, for the check binaries that read the forge.
 *
 * The wording test deliberately duplicates the review loop's own copy rather
 * than importing it: a check binary carries no dependency on the loop.
 */

import { execFileSync } from 'node:child_process'

/** The rate-limit wording GitHub's REST and GraphQL APIs use, primary and secondary — nothing that merely mentions GitHub matches. */
const GITHUB_RATE_LIMIT_WORDING = /api rate limit (?:already )?exceeded|secondary rate limit|rate limit exceeded/i

const SECONDARY_RATE_LIMIT_WORDING = /secondary rate limit/i

/** Which of GitHub's separately counted budgets a refused call drew on. */
export type RateLimitBudget = 'GraphQL' | 'REST'

/** Is this `gh` error text GitHub refusing the call because of a rate limit? */
export function isGithubRateLimitError(text: string): boolean {
  return GITHUB_RATE_LIMIT_WORDING.test(text)
}

/** `gh` prefixes every GraphQL API error with `GraphQL:`; anything else came from the REST API. */
export function rateLimitBudget(errorText: string): RateLimitBudget {
  return errorText.trimStart().startsWith('GraphQL:') ? 'GraphQL' : 'REST'
}

/** Runs `gh api rate_limit` and returns its stdout. Injectable so tests need no forge. */
export type RateLimitReader = () => string

/**
 * Inherits this process's environment, so `gh` answers with the same token
 * the refused call ran with. The `rate_limit` endpoint does not count against
 * any budget, so asking it never makes the refusal worse.
 */
const defaultReader: RateLimitReader = () =>
  execFileSync('gh', ['api', 'rate_limit'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * The budget's reset, in epoch seconds, from `GET /rate_limit`'s
 * `resources.<graphql|core>.reset`. `null` when no reset applies: the read
 * failed, the reply carries no usable reset, or that budget still has calls
 * left — the refusal was then a secondary limit, which reports no reset.
 */
export function readRateLimitReset(budget: RateLimitBudget, read: RateLimitReader = defaultReader): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(read())
  } catch {
    return null
  }
  const resources = (parsed as { resources?: Record<string, { reset?: unknown; remaining?: unknown }> }).resources
  const entry = resources?.[budget === 'GraphQL' ? 'graphql' : 'core']
  if (!entry || typeof entry.reset !== 'number' || !Number.isFinite(entry.reset) || entry.reset <= 0) return null
  if (typeof entry.remaining === 'number' && entry.remaining > 0) return null
  return entry.reset
}

/** Epoch seconds as `HH:MM UTC`. */
export function formatResetUtc(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm} UTC`
}

/**
 * "GitHub rate limit (<budget>), resets at HH:MM UTC", or "… resets in a few
 * minutes" when no reset is reported (a secondary limit).
 */
export function rateLimitMessage(errorText: string, read: RateLimitReader = defaultReader): string {
  const budget = rateLimitBudget(errorText)
  const reset = SECONDARY_RATE_LIMIT_WORDING.test(errorText) ? null : readRateLimitReset(budget, read)
  const when = reset === null ? 'resets in a few minutes' : `resets at ${formatResetUtc(reset)}`
  return `GitHub rate limit (${budget}), ${when}`
}

/** The stderr `execFileSync` captured on a failed `gh` call, plus its message, as one text. */
export function execErrorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown }
  const stderr = e?.stderr === undefined || e.stderr === null ? '' : String(e.stderr)
  const message = typeof e?.message === 'string' ? e.message : ''
  return stderr.trim() !== '' ? `${stderr}\n${message}` : message
}
