import { describe, expect, it, vi } from 'vitest'

/**
 * `fetchOpenIssuesByLabel`'s "nothing found yet" states — an empty slug
 * list, a slug with no open Issues under its tranche label, and the fail-open
 * contract on a GraphQL error — plus the one batched-query mapping story:
 * each slug's aliased sub-query maps back to its own `ForgeIssue[]`, never
 * another slug's.
 */

const graphqlClient = vi.fn()

vi.mock('@octokit/graphql', () => ({
  graphql: { defaults: () => graphqlClient }
}))

const { fetchOpenIssuesByLabel } = await import('./fetch-open-issues')

describe('fetchOpenIssuesByLabel', () => {
  it('returns an empty map without querying when slugs is empty', async () => {
    const result = await fetchOpenIssuesByLabel([], 'acme', 'widgets', 'token')

    expect(result.size).toBe(0)
    expect(graphqlClient).not.toHaveBeenCalled()
  })

  it('maps each aliased sub-query back to its own slug, hyphens folded to underscores', async () => {
    graphqlClient.mockResolvedValueOnce({
      repository: {
        tranche_vinaya_engine_v1: {
          nodes: [{ number: 10, body: 'body a', labels: { nodes: [{ name: 'vinaya/tier:1' }] } }]
        },
        tranche_vinaya_cli_v1: { nodes: [] }
      }
    })

    const result = await fetchOpenIssuesByLabel(['vinaya-engine-v1', 'vinaya-cli-v1'], 'acme', 'widgets', 'token')

    expect(result.get('vinaya-engine-v1')).toEqual([{ number: 10, body: 'body a', labels: ['vinaya/tier:1'] }])
    expect(result.get('vinaya-cli-v1')).toEqual([])
  })

  it('defaults a null body to an empty string and missing labels to an empty array', async () => {
    graphqlClient.mockResolvedValueOnce({
      repository: {
        tranche_vinaya_engine_v1: { nodes: [{ number: 11, body: null, labels: null }] }
      }
    })

    const result = await fetchOpenIssuesByLabel(['vinaya-engine-v1'], 'acme', 'widgets', 'token')

    expect(result.get('vinaya-engine-v1')).toEqual([{ number: 11, body: '', labels: [] }])
  })

  it('returns an empty map when the query errors — fail-open, never throws', async () => {
    graphqlClient.mockRejectedValueOnce(new Error('502 Bad Gateway'))

    const result = await fetchOpenIssuesByLabel(['vinaya-engine-v1'], 'acme', 'widgets', 'token')

    expect(result.size).toBe(0)
  })

  it('returns an empty map when the repository is not visible to the token', async () => {
    graphqlClient.mockResolvedValueOnce({ repository: null })

    const result = await fetchOpenIssuesByLabel(['vinaya-engine-v1'], 'acme', 'widgets', 'token')

    expect(result.size).toBe(0)
  })
})
