import { describe, expect, it, vi } from 'vitest'

/**
 * `fetchTaskIssueRefs`'s "nothing found yet" states — an empty issue-number
 * list and a missing token — plus the mapping story: each aliased issue node
 * resolves through `resolveTaskIssueRef` (real task Issue → `TaskIssueRef`,
 * ordinary Issue → `null`, absent entirely when the query errors).
 */

const graphqlClient = vi.fn()
const resolveGithubToken = vi.fn()

vi.mock('@octokit/graphql', () => ({
  graphql: { defaults: () => graphqlClient }
}))

vi.mock('./github-token', () => ({ resolveGithubToken }))

const { fetchTaskIssueRefs } = await import('./fetch-task-issue-refs')

describe('fetchTaskIssueRefs', () => {
  it('returns an empty map without resolving a token when issueNumbers is empty', async () => {
    const result = await fetchTaskIssueRefs('acme', 'widgets', [])

    expect(result.size).toBe(0)
    expect(resolveGithubToken).not.toHaveBeenCalled()
  })

  it('returns an empty map when no token is available — fail-open', async () => {
    resolveGithubToken.mockResolvedValueOnce(null)

    const result = await fetchTaskIssueRefs('acme', 'widgets', [42])

    expect(result.size).toBe(0)
    expect(graphqlClient).not.toHaveBeenCalled()
  })

  it('resolves a real task Issue to its TaskIssueRef', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockResolvedValueOnce({
      repository: {
        i_42: {
          title: '[vinaya-verification-v1] 6 — Mocked-gh test harness',
          labels: { nodes: [{ name: 'vinaya/tranche:vinaya-verification-v1' }] }
        }
      }
    })

    const result = await fetchTaskIssueRefs('acme', 'widgets', [42])

    expect(result.get(42)).toEqual({ trancheSlug: 'vinaya-verification-v1', taskId: '6' })
  })

  it('resolves an ordinary (non-task) Issue to null', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockResolvedValueOnce({
      repository: { i_7: { title: 'A plain bug report', labels: { nodes: [] } } }
    })

    const result = await fetchTaskIssueRefs('acme', 'widgets', [7])

    expect(result.get(7)).toBeNull()
  })

  it('skips a number the query returned nothing for — absent, not null', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockResolvedValueOnce({ repository: { i_7: null } })

    const result = await fetchTaskIssueRefs('acme', 'widgets', [7])

    expect(result.has(7)).toBe(false)
  })

  it('returns an empty map when the query errors — fail-open, never throws', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockRejectedValueOnce(new Error('502 Bad Gateway'))

    const result = await fetchTaskIssueRefs('acme', 'widgets', [42])

    expect(result.size).toBe(0)
  })

  it('returns an empty map when the repository is not visible to the token', async () => {
    resolveGithubToken.mockResolvedValueOnce('token')
    graphqlClient.mockResolvedValueOnce({ repository: null })

    const result = await fetchTaskIssueRefs('acme', 'widgets', [42])

    expect(result.size).toBe(0)
  })
})
