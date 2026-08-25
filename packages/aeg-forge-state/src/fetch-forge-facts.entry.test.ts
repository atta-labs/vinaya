import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The "nothing found yet" degradation contract of `fetchForgeFacts` and
 * `fetchForgeTasksByLabel` — no token, no tasks/no label matches, and a
 * network/API error — none of which `fetch-forge-facts.test.ts`'s
 * fixture-driven regression suite exercises (that file mocks the batch
 * query's shape directly and always supplies an explicit token).
 *
 * A separate file per the `verify-coherence.<topic>.test.ts` convention
 * already used elsewhere in this repo, rather than reshaping the existing
 * fixture-based mock to also serve `fetchForgeTasksByLabel`'s entirely
 * different `TrancheIssues` query shape.
 */

const graphqlClient = vi.fn()
const resolveGithubToken = vi.fn()

vi.mock('@octokit/graphql', () => ({
  graphql: { defaults: () => graphqlClient }
}))

vi.mock('./github-token', () => ({ resolveGithubToken }))

const { fetchForgeFacts, fetchForgeTasksByLabel } = await import('./fetch-forge-facts')

beforeEach(() => {
  graphqlClient.mockReset()
  resolveGithubToken.mockReset()
})

describe('fetchForgeFacts — degradation contract', () => {
  it('returns unavailable with a reason when no token is discoverable', async () => {
    resolveGithubToken.mockResolvedValueOnce(null)

    const snapshot = await fetchForgeFacts({ owner: 'acme', repo: 'widgets', tranche: 'iter', tasks: [] })

    expect(snapshot.unavailable).toBe(true)
    expect(snapshot.reason).toMatch(/no github token/i)
    expect(snapshot.facts.size).toBe(0)
    expect(graphqlClient).not.toHaveBeenCalled()
  })

  it('returns available-but-empty when every task has no Issue number, without querying', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')

    const snapshot = await fetchForgeFacts({
      owner: 'acme',
      repo: 'widgets',
      tranche: 'iter',
      tasks: [{ id: '1', issue: null }]
    })

    expect(snapshot.unavailable).toBe(false)
    expect(snapshot.facts.size).toBe(0)
    expect(graphqlClient).not.toHaveBeenCalled()
  })

  it('returns unavailable with a reason when the query itself errors', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockRejectedValueOnce(new Error('502 Bad Gateway'))

    const snapshot = await fetchForgeFacts({
      owner: 'acme',
      repo: 'widgets',
      tranche: 'iter',
      tasks: [{ id: '1', issue: 100 }]
    })

    expect(snapshot.unavailable).toBe(true)
    expect(snapshot.reason).toMatch(/502 Bad Gateway/)
  })

  it('returns unavailable with a reason when the repository is not visible to the token', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockResolvedValueOnce({ repository: null })

    const snapshot = await fetchForgeFacts({
      owner: 'acme',
      repo: 'widgets',
      tranche: 'iter',
      tasks: [{ id: '1', issue: 100 }]
    })

    expect(snapshot.unavailable).toBe(true)
    expect(snapshot.reason).toMatch(/not visible/)
  })
})

describe('fetchForgeTasksByLabel', () => {
  it('returns an empty array without querying when no token is discoverable', async () => {
    resolveGithubToken.mockResolvedValueOnce(null)

    const refs = await fetchForgeTasksByLabel({ owner: 'acme', repo: 'widgets', trancheSlug: 'iter' })

    expect(refs).toEqual([])
    expect(graphqlClient).not.toHaveBeenCalled()
  })

  it('parses each labeled Issue title into an id/issue ref', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockResolvedValueOnce({
      repository: {
        issues: {
          nodes: [
            { number: 34, title: '[iter] 6 — Mocked-gh test harness for aeg-forge-state fetchers' },
            { number: 35, title: '[iter] 7 — Some other task' }
          ]
        }
      }
    })

    const refs = await fetchForgeTasksByLabel({ owner: 'acme', repo: 'widgets', trancheSlug: 'iter' })

    expect(refs).toEqual([
      { id: '6', issue: 34 },
      { id: '7', issue: 35 }
    ])
  })

  it('skips a title that does not match the `[slug] id — title` convention', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockResolvedValueOnce({
      repository: { issues: { nodes: [{ number: 34, title: 'A plain bug report' }] } }
    })

    const refs = await fetchForgeTasksByLabel({ owner: 'acme', repo: 'widgets', trancheSlug: 'iter' })

    expect(refs).toEqual([])
  })

  it('returns an empty array when the query errors — fail-open, never throws', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockRejectedValueOnce(new Error('502 Bad Gateway'))

    const refs = await fetchForgeTasksByLabel({ owner: 'acme', repo: 'widgets', trancheSlug: 'iter' })

    expect(refs).toEqual([])
  })

  it('returns an empty array when the label has no matching Issues', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockResolvedValueOnce({ repository: { issues: { nodes: [] } } })

    const refs = await fetchForgeTasksByLabel({ owner: 'acme', repo: 'widgets', trancheSlug: 'iter' })

    expect(refs).toEqual([])
  })
})
