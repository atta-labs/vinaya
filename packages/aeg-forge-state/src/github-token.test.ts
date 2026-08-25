import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `resolveGithubToken`'s precedence chain (explicit → `GITHUB_TOKEN` →
 * `GH_TOKEN` → `gh auth token`) and its "never throw, return `null`"
 * contract on the final fallback — the seam every other fetcher in this
 * package depends on to short-circuit to a graceful no-token snapshot
 * instead of crashing.
 *
 * `gh auth token` is exercised at the same `node:child_process` seam
 * `gh.test.ts` mocks, mirroring that file's `promisify.custom` stub rather
 * than a second forge-access mechanism.
 */

const forge = vi.hoisted(() => ({
  respond: async (): Promise<{ stdout: string }> => ({ stdout: '' })
}))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = (() => {
    throw new Error('callback form not used by these tests')
  }) as unknown as ((...args: unknown[]) => void) & Record<symbol, unknown>

  execFile[promisify.custom] = async () => forge.respond()

  return { execFile }
})

const { resolveGithubToken } = await import('./github-token')

describe('resolveGithubToken', () => {
  const originalGithubToken = process.env.GITHUB_TOKEN
  const originalGhToken = process.env.GH_TOKEN

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    forge.respond = async () => ({ stdout: '' })
  })

  afterEach(() => {
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalGithubToken
    if (originalGhToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = originalGhToken
  })

  it('returns the explicit token without touching env or `gh`', async () => {
    process.env.GITHUB_TOKEN = 'env-token'
    forge.respond = async () => {
      throw new Error('should not shell out when an explicit token is given')
    }

    expect(await resolveGithubToken('explicit-token')).toBe('explicit-token')
  })

  it('ignores an empty-string explicit token and falls through to env', async () => {
    process.env.GITHUB_TOKEN = 'env-token'

    expect(await resolveGithubToken('')).toBe('env-token')
  })

  it('prefers GITHUB_TOKEN over GH_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'from-github-token'
    process.env.GH_TOKEN = 'from-gh-token'

    expect(await resolveGithubToken()).toBe('from-github-token')
  })

  it('falls back to GH_TOKEN when GITHUB_TOKEN is unset', async () => {
    process.env.GH_TOKEN = 'from-gh-token'

    expect(await resolveGithubToken()).toBe('from-gh-token')
  })

  it('falls back to `gh auth token` when no explicit token or env var is set', async () => {
    forge.respond = async () => ({ stdout: 'gh-cli-token\n' })

    expect(await resolveGithubToken()).toBe('gh-cli-token')
  })

  it('returns null when `gh auth token` yields an empty token', async () => {
    forge.respond = async () => ({ stdout: '   \n' })

    expect(await resolveGithubToken()).toBeNull()
  })

  it('returns null, never throws, when `gh auth token` fails (not logged in / gh missing)', async () => {
    forge.respond = async () => {
      throw new Error('gh: command not found')
    }

    await expect(resolveGithubToken()).resolves.toBeNull()
  })
})
