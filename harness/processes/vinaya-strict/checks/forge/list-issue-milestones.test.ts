import type { Mock } from 'bun:test'
import { describe, expect, it, mock } from 'bun:test'

mock.module('../../../../kernel/adapters/code-host/github/gh', () => ({
  ghIssueListByAnyLabel: mock()
}))

const { ghIssueListByAnyLabel } = await import('../../../../kernel/adapters/code-host/github/gh')
const { issueMilestonesFromIssues, listIssueMilestonesForSlug } = await import('./list-issue-milestones')

describe('listIssueMilestonesForSlug', () => {
  it('maps each open Issue to its milestone title, or null when unattached', () => {
    mocked(ghIssueListByAnyLabel).mockReturnValue([
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
    mocked(ghIssueListByAnyLabel).mockReturnValue([
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
    mocked(ghIssueListByAnyLabel).mockReturnValue(ISSUES)

    expect(issueMilestonesFromIssues(ISSUES)).toEqual(listIssueMilestonesForSlug('daniboomerang', 'attalabs', 'iter'))
  })

  it('issues no forge call of its own', () => {
    mocked(ghIssueListByAnyLabel).mockClear()

    issueMilestonesFromIssues(ISSUES)

    expect(ghIssueListByAnyLabel).not.toHaveBeenCalled()
  })
})

const mocked = <T extends (...args: never[]) => unknown>(value: T) =>
  value as unknown as Mock<(...args: Parameters<T>) => ReturnType<T>>
