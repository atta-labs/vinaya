import { describe, expect, it, vi } from 'vitest'

vi.mock('./gh', () => ({
  ghIssueListByAnyLabel: vi.fn()
}))

const { ghIssueListByAnyLabel } = await import('./gh')
const { issueMilestonesFromIssues, listIssueMilestonesForSlug } = await import('./list-issue-milestones')

describe('listIssueMilestonesForSlug', () => {
  it('maps each open Issue to its milestone title, or null when unattached', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 1,
        title: '[iter] 1 — a',
        body: '',
        state: 'OPEN',
        labels: [{ name: 'vinaya/tranche:iter' }],
        milestone: { title: 'iter' }
      },
      {
        number: 2,
        title: '[iter] 2 — b',
        body: '',
        state: 'OPEN',
        labels: [{ name: 'vinaya/tranche:iter' }],
        milestone: null
      }
    ])

    expect(listIssueMilestonesForSlug('daniboomerang', 'attalabs', 'iter')).toEqual([
      { issue: 1, milestoneTitle: 'iter' },
      { issue: 2, milestoneTitle: null }
    ])
  })

  it('excludes closed Issues — only open Issues are in scope for the active-tranche drift check', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 1,
        title: '[iter] 1 — a',
        body: '',
        state: 'CLOSED',
        labels: [{ name: 'vinaya/tranche:iter' }],
        milestone: null
      }
    ])

    expect(listIssueMilestonesForSlug('daniboomerang', 'attalabs', 'iter')).toEqual([])
  })
})

describe('issueMilestonesFromIssues', () => {
  const ISSUES = [
    {
      number: 1,
      title: '[iter] 1 — a',
      body: '',
      state: 'OPEN' as const,
      labels: [{ name: 'vinaya/tranche:iter' }],
      milestone: { title: 'iter' }
    },
    {
      number: 2,
      title: '[iter] 2 — b',
      body: '',
      state: 'OPEN' as const,
      labels: [{ name: 'vinaya/tranche:iter' }],
      milestone: null
    },
    {
      number: 3,
      title: '[iter] 3 — c',
      body: '',
      state: 'CLOSED' as const,
      labels: [{ name: 'vinaya/tranche:iter' }],
      milestone: { title: 'iter' }
    }
  ]

  it('derives the same facts from an already-fetched list as the fetching wrapper does', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue(ISSUES)

    expect(issueMilestonesFromIssues(ISSUES)).toEqual(listIssueMilestonesForSlug('daniboomerang', 'attalabs', 'iter'))
  })

  it('issues no forge call of its own', () => {
    vi.mocked(ghIssueListByAnyLabel).mockClear()

    issueMilestonesFromIssues(ISSUES)

    expect(ghIssueListByAnyLabel).not.toHaveBeenCalled()
  })
})
