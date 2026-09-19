import { describe, expect, it, vi } from 'vitest'

/**
 * `fetchProvenance`'s primary path (closing PR body/comments), the
 * cross-reference fallback for a non-PR closer (manual `gh issue close`),
 * and the fail-open "nothing found yet" states — an empty issue-number list
 * and a GraphQL error on either query.
 *
 * The primary and cross-reference queries are distinguished by their
 * `timelineItems` filter (`itemTypes: [CLOSED_EVENT]` vs
 * `[CROSS_REFERENCED_EVENT]`) so one mock can route to the right fixture per
 * call, mirroring `fetch-forge-facts.test.ts`'s query-text-inspection
 * pattern.
 */

const graphqlClient = vi.fn()

vi.mock('@octokit/graphql', () => ({
  graphql: { defaults: () => graphqlClient }
}))

const { fetchProvenance } = await import('./fetch-provenance')

const PROVENANCE_BODY = '### AEG provenance\n- Issue:        #42\n'

describe('fetchProvenance', () => {
  it('returns an empty map without querying when issueNums is empty', async () => {
    const result = await fetchProvenance([], 'acme', 'widgets', 'token')

    expect(result.size).toBe(0)
    expect(graphqlClient).not.toHaveBeenCalled()
  })

  it('finds a provenance block in the closing PR body', async () => {
    graphqlClient.mockResolvedValueOnce({
      repository: {
        i_42: {
          timelineItems: {
            nodes: [{ closer: { number: 100, body: PROVENANCE_BODY, comments: { nodes: [] } } }]
          }
        }
      }
    })

    const result = await fetchProvenance([42], 'acme', 'widgets', 'token')

    expect(result.get(42)).toBe(true)
  })

  it('finds a provenance block in a comment when the PR body has none', async () => {
    graphqlClient.mockResolvedValueOnce({
      repository: {
        i_42: {
          timelineItems: {
            nodes: [
              { closer: { number: 100, body: 'unrelated body', comments: { nodes: [{ body: PROVENANCE_BODY }] } } }
            ]
          }
        }
      }
    })

    const result = await fetchProvenance([42], 'acme', 'widgets', 'token')

    expect(result.get(42)).toBe(true)
  })

  it('is false when the closing PR carries no provenance block at all', async () => {
    graphqlClient.mockResolvedValueOnce({
      repository: {
        i_42: {
          timelineItems: { nodes: [{ closer: { number: 100, body: 'no marker here', comments: { nodes: [] } } }] }
        }
      }
    })

    const result = await fetchProvenance([42], 'acme', 'widgets', 'token')

    expect(result.get(42)).toBe(false)
  })

  it('is false when the Issue was never closed', async () => {
    graphqlClient.mockResolvedValueOnce({ repository: { i_42: null } })

    const result = await fetchProvenance([42], 'acme', 'widgets', 'token')

    expect(result.get(42)).toBe(false)
  })

  it('falls back to cross-referenced PRs when the closer is a Commit (empty fragment), and matches by Issue field', async () => {
    graphqlClient
      // primary query — closer is a Commit, so the `... on PullRequest` fragment is `{}`
      .mockResolvedValueOnce({ repository: { i_42: { timelineItems: { nodes: [{ closer: {} }] } } } })
      // cross-reference fallback query
      .mockResolvedValueOnce({
        repository: {
          i_42: {
            timelineItems: {
              nodes: [
                // Mentions this issue but its own provenance targets a different issue — must not match.
                { source: { number: 200, body: '### AEG provenance\n- Issue:        #99\n', comments: { nodes: [] } } },
                { source: { number: 201, body: PROVENANCE_BODY, comments: { nodes: [] } } }
              ]
            }
          }
        }
      })

    const result = await fetchProvenance([42], 'acme', 'widgets', 'token')

    expect(result.get(42)).toBe(true)
  })

  it('falls back to cross-referenced PRs when the closer is a manual close (null)', async () => {
    graphqlClient
      .mockResolvedValueOnce({ repository: { i_42: { timelineItems: { nodes: [{ closer: null }] } } } })
      .mockResolvedValueOnce({ repository: { i_42: { timelineItems: { nodes: [] } } } })

    const result = await fetchProvenance([42], 'acme', 'widgets', 'token')

    expect(result.get(42)).toBe(false)
  })

  it('returns an empty map when the primary query errors — fail-open, never throws', async () => {
    graphqlClient.mockRejectedValueOnce(new Error('502 Bad Gateway'))

    const result = await fetchProvenance([42], 'acme', 'widgets', 'token')

    expect(result.size).toBe(0)
  })

  it('leaves the entry absent (not `false`) when the cross-reference fallback query itself errors', async () => {
    // The primary loop defers a null-closer issue to the fallback without
    // ever calling `result.set` for it; if the fallback then errors, the
    // caller sees no entry at all rather than a settled `false` — distinct
    // from the "closed by a PR with no provenance" case above.
    graphqlClient
      .mockResolvedValueOnce({ repository: { i_42: { timelineItems: { nodes: [{ closer: null }] } } } })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))

    const result = await fetchProvenance([42], 'acme', 'widgets', 'token')

    expect(result.has(42)).toBe(false)
  })
})
