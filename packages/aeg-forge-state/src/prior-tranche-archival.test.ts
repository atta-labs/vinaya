import { describe, expect, it, vi } from 'vitest'
import type { GhIssue } from './gh'
import { createGhMock } from './test-support/mock-gh'

vi.mock('./gh', () => createGhMock())

const { ghApiGetAllPagesAsync, ghIssueListByLabelAsync } = await import('./gh')
const { defaultPriorTrancheArchivalDeps, resolvePriorTrancheArchival } = await import('./prior-tranche-archival')
type PriorTrancheArchivalDeps = import('./prior-tranche-archival').PriorTrancheArchivalDeps
type PriorTrancheArchivalFact = import('./prior-tranche-archival').PriorTrancheArchivalFact
type ActiveTrancheIssues = import('./prior-tranche-archival').ActiveTrancheIssues

const REPO = { owner: 'atta-labs', repo: 'vinaya' }

const taskIssue = (slug: string, n: number, state: 'OPEN' | 'CLOSED', project = 'cli'): GhIssue => ({
  number: 100 + n,
  title: `[${slug}] ${n} — Task ${n}`,
  body: `**Project:** ${project}`,
  state,
  labels: [{ name: `vinaya/tranche:${slug}` }],
  milestone: null
})

/** An active tranche whose every task Issue is closed — kept active by an open Milestone titled with its slug. */
const allClosed = (slug = 'prior-tranche-v1', project = 'cli'): ActiveTrancheIssues => ({
  slug,
  issues: [taskIssue(slug, 1, 'CLOSED', project), taskIssue(slug, 2, 'CLOSED', project)]
})

const deps = (tranches: ActiveTrancheIssues[] = [allClosed()]): PriorTrancheArchivalDeps => ({
  activeTranches: async () => tranches
})

const unarchived = (slug: string): PriorTrancheArchivalFact => ({
  project: 'cli',
  priorTrancheSlug: slug,
  archived: false
})

describe('resolvePriorTrancheArchival — a failed read is unknown, never "no prior tranche"', () => {
  it('a failed active-tranche read fails closed with no fact', async () => {
    const result = await resolvePriorTrancheArchival(['cli'], 'x', REPO, {
      activeTranches: async () => {
        throw new Error('milestones unreachable')
      }
    })
    expect(result.infraFailure).toContain('severity:infra')
    expect(result.infraFailure).toContain('active tranches')
    expect(result.infraFailure).toContain('milestones unreachable')
    expect(result.facts).toEqual([])
  })

  it('the failure message does not name the verifier', async () => {
    const result = await resolvePriorTrancheArchival(['cli'], 'x', REPO, {
      activeTranches: async () => {
        throw new Error('gh exploded')
      }
    })
    expect(result.infraFailure).not.toContain('verify-dispatch')
  })
})

describe('resolvePriorTrancheArchival — answers when every read succeeds', () => {
  it('a prior tranche with every Issue closed yields the archival fact', async () => {
    const result = await resolvePriorTrancheArchival(['cli'], 'x', REPO, deps())
    expect(result).toEqual({ facts: [unarchived('prior-tranche-v1')], infraFailure: null })
  })

  it('a prior tranche with open Issues is no block and no failure', async () => {
    const slug = 'prior-tranche-v1'
    const result = await resolvePriorTrancheArchival(
      ['cli'],
      'x',
      REPO,
      deps([{ slug, issues: [taskIssue(slug, 1, 'CLOSED'), taskIssue(slug, 2, 'OPEN')] }])
    )
    expect(result).toEqual({ facts: [{ project: 'cli', priorTrancheSlug: null, archived: false }], infraFailure: null })
  })

  it('a prior tranche touching another project is skipped', async () => {
    const result = await resolvePriorTrancheArchival(['sources'], 'x', REPO, deps())
    expect(result.facts).toEqual([{ project: 'sources', priorTrancheSlug: null, archived: false }])
  })

  it('each project gets the first matching candidate', async () => {
    const result = await resolvePriorTrancheArchival(
      ['cli', 'sources'],
      'x',
      REPO,
      deps([allClosed('first-v1', 'sources'), allClosed('second-v1', 'cli')])
    )
    expect(result).toEqual({
      facts: [unarchived('second-v1'), { project: 'sources', priorTrancheSlug: 'first-v1', archived: false }],
      infraFailure: null
    })
  })

  it('no projects reads nothing and returns no fact', async () => {
    const result = await resolvePriorTrancheArchival([], 'x', REPO, {
      activeTranches: async () => {
        throw new Error('must not be read')
      }
    })
    expect(result).toEqual({ facts: [], infraFailure: null })
  })
})

describe('the default read lists each tranche label once and retries a failed read once', () => {
  const MILESTONES = [
    { number: 1, title: 'prior-tranche-v1', description: 'Prior.', state: 'open' },
    { number: 2, title: 'other-tranche-v1', description: 'Other.', state: 'open' },
    { number: 3, title: 'own-tranche-v1', description: 'Own.', state: 'open' }
  ]
  const LABELS = [{ name: 'vinaya/tranche:label-only-v1' }, { name: 'vinaya/tranche:planned-v1' }]
  const ISSUES: Record<string, GhIssue[]> = {
    'vinaya/tranche:prior-tranche-v1': allClosed('prior-tranche-v1').issues,
    'vinaya/tranche:other-tranche-v1': allClosed('other-tranche-v1', 'sources').issues,
    'vinaya/tranche:own-tranche-v1': [taskIssue('own-tranche-v1', 1, 'OPEN')],
    'vinaya/tranche:label-only-v1': [taskIssue('label-only-v1', 1, 'OPEN')],
    'vinaya/tranche:planned-v1': []
  }

  function mockForge(failOnceFor: string | null = null) {
    vi.mocked(ghApiGetAllPagesAsync).mockReset()
    vi.mocked(ghApiGetAllPagesAsync).mockImplementation(async (path: string) =>
      path.includes('/labels') ? LABELS : MILESTONES
    )
    vi.mocked(ghIssueListByLabelAsync).mockReset()
    let failed = false
    vi.mocked(ghIssueListByLabelAsync).mockImplementation(async (_o, _r, label: string) => {
      if (label === failOnceFor && !failed) {
        failed = true
        throw new Error('read: connection reset by peer')
      }
      return ISSUES[label] ?? []
    })
  }

  const readsPerLabel = (): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const [, , label] of vi.mocked(ghIssueListByLabelAsync).mock.calls)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    return counts
  }

  it('reads every tranche label at most once in a whole resolution, candidates included', async () => {
    mockForge()
    const result = await resolvePriorTrancheArchival(['cli', 'sources', 'vinaya'], 'own-tranche-v1', REPO)
    expect(result).toEqual({
      facts: [
        unarchived('prior-tranche-v1'),
        { project: 'sources', priorTrancheSlug: 'other-tranche-v1', archived: false },
        { project: 'vinaya', priorTrancheSlug: null, archived: false }
      ],
      infraFailure: null
    })
    const counts = readsPerLabel()
    expect([...counts.keys()].sort()).toEqual(Object.keys(ISSUES).sort())
    for (const count of counts.values()) expect(count).toBe(1)
    expect(vi.mocked(ghApiGetAllPagesAsync)).toHaveBeenCalledTimes(2)
  })

  it('a label read that fails once is retried once and the resolution still answers', async () => {
    mockForge('vinaya/tranche:prior-tranche-v1')
    const result = await resolvePriorTrancheArchival(['cli'], 'own-tranche-v1', REPO)
    expect(result).toEqual({ facts: [unarchived('prior-tranche-v1')], infraFailure: null })
    expect(readsPerLabel().get('vinaya/tranche:prior-tranche-v1')).toBe(2)
  })

  it('a label read that fails twice is the infrastructure failure, never a pass', async () => {
    mockForge()
    vi.mocked(ghIssueListByLabelAsync).mockImplementation(async (_o, _r, label: string) => {
      if (label === 'vinaya/tranche:planned-v1') throw new Error('read: connection reset by peer')
      return ISSUES[label] ?? []
    })
    const result = await resolvePriorTrancheArchival(['cli'], 'own-tranche-v1', REPO)
    expect(result.facts).toEqual([])
    expect(result.infraFailure).toContain('severity:infra')
    expect(result.infraFailure).toContain('could not read the active tranches')
    expect(readsPerLabel().get('vinaya/tranche:planned-v1')).toBe(2)
  })

  it('the default deps hand back each active candidate with the Issues the index read for it', async () => {
    mockForge()
    const tranches = await defaultPriorTrancheArchivalDeps().activeTranches('own-tranche-v1', REPO)
    expect(tranches.map((t) => t.slug).sort()).toEqual(['label-only-v1', 'other-tranche-v1', 'prior-tranche-v1'])
    for (const t of tranches) expect(t.issues).toEqual(ISSUES[`vinaya/tranche:${t.slug}`])
  })
})
