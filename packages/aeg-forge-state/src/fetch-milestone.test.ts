import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGhMock } from './test-support/mock-gh'

vi.mock('./gh', () => createGhMock())

const { ghApiGet, ghApiGetAsync, ghApiGetAllPagesAsync, ghIssueListByLabel, ghIssueListByLabelAsync } = await import(
  './gh'
)
const { findMilestoneForSlug, indexTrancheMilestonesAsync, listActiveTrancheSlugs, listArchivedTrancheSlugs } =
  await import('./fetch-milestone')

const OWNER = 'daniboomerang'
const REPO = 'attalabs'
const FIXTURES = join(__dirname, 'fixtures')
/** Captured live 2026-07-06 via `gh api repos/daniboomerang/attalabs/milestones?state=all` —
 * the real, current state: no Milestone exists yet for any active tranche. */
const emptyMilestones = JSON.parse(readFileSync(join(FIXTURES, 'milestones-empty.json'), 'utf8'))

/** Minimal valid `GhIssue`, state-only — every other field is irrelevant to lifecycle derivation. */
function issue(state: 'OPEN' | 'CLOSED') {
  return { number: 1, title: 'x', body: '', state, labels: [], milestone: null }
}

describe('findMilestoneForSlug', () => {
  it('returns goal + active lifecycle for an open milestone matching the slug exactly', () => {
    vi.mocked(ghApiGet).mockReturnValue([
      { title: 'some-unrelated-slug', description: 'not this one', state: 'open' },
      { title: 'aeg-forge-state-v1', description: 'Migrate this repo governance state.', state: 'open' }
    ])

    expect(findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')).toEqual({
      goal: 'Migrate this repo governance state.',
      lifecycle: 'active'
    })
  })

  it('returns goal + complete lifecycle for a closed milestone', () => {
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'vinaya-cli-v1', description: 'Ship the CLI.', state: 'closed' }])

    expect(findMilestoneForSlug(OWNER, REPO, 'vinaya-cli-v1')).toEqual({
      goal: 'Ship the CLI.',
      lifecycle: 'complete'
    })
  })

  it('treats a missing description as an empty goal', () => {
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'aeg-forge-state-v1', description: null, state: 'open' }])

    expect(findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')).toEqual({ goal: '', lifecycle: 'active' })
  })

  it('never consults the label path once a legacy Milestone matches', () => {
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'aeg-forge-state-v1', description: null, state: 'open' }])
    vi.mocked(ghIssueListByLabel).mockClear()

    findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')

    expect(ghIssueListByLabel).not.toHaveBeenCalled()
  })

  it('derives active from the label’s Issues when no legacy Milestone matches (the real, current fixture — no Milestone exists yet for any active tranche)', () => {
    vi.mocked(ghApiGet).mockReturnValue(emptyMilestones)
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('CLOSED'), issue('OPEN')])

    expect(findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')).toEqual({ goal: '', lifecycle: 'active' })
    expect(ghIssueListByLabel).toHaveBeenCalledWith(OWNER, REPO, 'vinaya/tranche:aeg-forge-state-v1')
  })

  it('derives complete from the label’s Issues when every one is closed and no legacy Milestone matches', () => {
    vi.mocked(ghApiGet).mockReturnValue(emptyMilestones)
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('CLOSED'), issue('CLOSED')])

    expect(findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')).toEqual({ goal: '', lifecycle: 'complete' })
  })

  it('derives planned (not complete) when the label carries zero Issues — the at-least-one guard', () => {
    vi.mocked(ghApiGet).mockReturnValue(emptyMilestones)
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    expect(findMilestoneForSlug(OWNER, REPO, 'brand-new-slug')).toEqual({ goal: '', lifecycle: 'planned' })
  })

  it('a Milestone shared by two tranches resolves both correctly from their own labels — neither reads the other', () => {
    // Neither slug legacy-matches: the shared Milestone is titled something
    // else entirely (e.g. a sprint name), never either tranche's own slug.
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'sprint-42', description: 'Q3 sprint', state: 'open' }])
    vi.mocked(ghIssueListByLabel).mockImplementation((_owner, _repo, label) => {
      if (label === 'vinaya/tranche:tranche-a') return [issue('OPEN')]
      if (label === 'vinaya/tranche:tranche-b') return [issue('CLOSED')]
      throw new Error(`unexpected label ${label}`)
    })

    expect(findMilestoneForSlug(OWNER, REPO, 'tranche-a')).toEqual({ goal: '', lifecycle: 'active' })
    expect(findMilestoneForSlug(OWNER, REPO, 'tranche-b')).toEqual({ goal: '', lifecycle: 'complete' })
  })
})

describe('listActiveTrancheSlugs', () => {
  function mockGh(milestones: unknown[], labelNames: string[]) {
    vi.mocked(ghApiGet).mockImplementation((path: string) => {
      if (path.includes('/labels')) return labelNames.map((name) => ({ name }))
      return milestones
    })
  }

  it('maps every open legacy milestone to its slug + goal, when no tranche labels exist', () => {
    mockGh(
      [
        { title: 'aeg-forge-state-v1', description: 'Migrate this repo governance state.', state: 'open' },
        { title: 'herald-hardening-v1', description: null, state: 'open' }
      ],
      []
    )

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual(
      expect.arrayContaining([
        { slug: 'aeg-forge-state-v1', goal: 'Migrate this repo governance state.' },
        { slug: 'herald-hardening-v1', goal: '' }
      ])
    )
  })

  it('requests the full state=all Milestone set, plus the label set — not the state=open-only set', () => {
    mockGh([], [])
    listActiveTrancheSlugs(OWNER, REPO)
    expect(ghApiGet).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/milestones?state=all&per_page=100`)
    expect(ghApiGet).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/labels?per_page=100`)
  })

  it('returns an empty list when nothing is open or active (the real, current fixture)', () => {
    mockGh(emptyMilestones, [])
    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([])
  })

  it('resolves a label-only tranche (no Milestone at all) as active when it has an open Issue', () => {
    mockGh([], ['vinaya/tranche:label-only-v1'])
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('OPEN')])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([{ slug: 'label-only-v1', goal: '' }])
  })

  it('excludes a label-only tranche whose Issues are all closed — complete, not active', () => {
    mockGh([], ['vinaya/tranche:done-v1'])
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('CLOSED')])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([])
  })

  it('excludes a label-only tranche with zero Issues — planned, not active', () => {
    mockGh([], ['vinaya/tranche:planned-v1'])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([])
  })

  it('a closed legacy Milestone is never resurrected as active by a same-named label', () => {
    mockGh([{ title: 'shipped-v1', description: 'Done.', state: 'closed' }], ['vinaya/tranche:shipped-v1'])
    // If the legacy check were skipped, this would resolve via the label path
    // and its (deliberately wrong-shaped) Issues would read as active.
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('OPEN')])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([])
  })
})

describe('listArchivedTrancheSlugs', () => {
  function mockGh(milestones: unknown[], labelNames: string[]) {
    vi.mocked(ghApiGet).mockImplementation((path: string) => {
      if (path.includes('/labels')) return labelNames.map((name) => ({ name }))
      return milestones
    })
  }

  it('maps every closed legacy milestone to its slug + goal', () => {
    mockGh([{ title: 'vinaya-cli-v1', description: 'Ship the CLI.', state: 'closed' }], [])

    expect(listArchivedTrancheSlugs(OWNER, REPO)).toEqual([{ slug: 'vinaya-cli-v1', goal: 'Ship the CLI.' }])
  })

  it('includes a label-only tranche whose Issues are all closed', () => {
    mockGh([], ['vinaya/tranche:done-v1'])
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('CLOSED'), issue('CLOSED')])

    expect(listArchivedTrancheSlugs(OWNER, REPO)).toEqual([{ slug: 'done-v1', goal: '' }])
  })

  it('excludes a label-only tranche with zero Issues — planned is neither active nor archived', () => {
    mockGh([], ['vinaya/tranche:planned-v1'])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    expect(listArchivedTrancheSlugs(OWNER, REPO)).toEqual([])
  })
})

describe('indexTrancheMilestonesAsync', () => {
  const MILESTONES = [
    { title: 'aeg-forge-state-v1', description: 'Migrate this repo governance state.', state: 'open' },
    { title: 'herald-hardening-v1', description: null, state: 'open' },
    { title: 'vinaya-cli-v1', description: 'Ship the CLI.', state: 'closed' }
  ]

  function mockPages(milestones: unknown[], labels: unknown[]) {
    vi.mocked(ghApiGetAllPagesAsync).mockImplementation(async (path: string) => {
      if (path.includes('/labels')) return labels
      return milestones
    })
  }

  it('splits the legacy Milestone population into active and archived lists, as before', async () => {
    mockPages(MILESTONES, [])

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active).toEqual([
      { slug: 'aeg-forge-state-v1', goal: 'Migrate this repo governance state.' },
      { slug: 'herald-hardening-v1', goal: '' }
    ])
    expect(index.archived).toEqual([{ slug: 'vinaya-cli-v1', goal: 'Ship the CLI.' }])
    expect(index.legacySlugs).toEqual(new Set(['aeg-forge-state-v1', 'herald-hardening-v1', 'vinaya-cli-v1']))
  })

  it('yields, per legacy slug, exactly what findMilestoneForSlug returns for the same data', async () => {
    mockPages(MILESTONES, [])
    vi.mocked(ghApiGet).mockImplementation((path: string) => {
      if (path.includes('/labels')) return []
      return MILESTONES
    })

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    for (const slug of ['aeg-forge-state-v1', 'herald-hardening-v1', 'vinaya-cli-v1']) {
      expect(index.facts.get(slug) ?? null).toEqual(findMilestoneForSlug(OWNER, REPO, slug))
    }
  })

  it('a slug absent from both populations has no entry, and findMilestoneForSlug agrees it is planned', async () => {
    mockPages(MILESTONES, [])
    vi.mocked(ghApiGet).mockImplementation((path: string) => {
      if (path.includes('/labels')) return []
      return MILESTONES
    })
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.facts.get('no-such-slug')).toBeUndefined()
    expect(findMilestoneForSlug(OWNER, REPO, 'no-such-slug')).toEqual({ goal: '', lifecycle: 'planned' })
  })

  it('folds in a label-only tranche (no matching Milestone at all), fetched exactly once', async () => {
    mockPages(MILESTONES, [{ name: 'vinaya/tranche:label-only-v1' }])
    vi.mocked(ghIssueListByLabelAsync).mockClear()
    vi.mocked(ghIssueListByLabelAsync).mockResolvedValue([issue('OPEN'), issue('CLOSED')])

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active).toContainEqual({ slug: 'label-only-v1', goal: '' })
    expect(index.legacySlugs.has('label-only-v1')).toBe(false)
    expect(ghIssueListByLabelAsync).toHaveBeenCalledTimes(1)
    expect(ghIssueListByLabelAsync).toHaveBeenCalledWith(OWNER, REPO, 'vinaya/tranche:label-only-v1')
  })

  it('a label matching a legacy slug is never double-counted or re-fetched by Issue', async () => {
    mockPages(MILESTONES, [{ name: 'vinaya/tranche:aeg-forge-state-v1' }])
    vi.mocked(ghIssueListByLabelAsync).mockClear()

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active.filter((r) => r.slug === 'aeg-forge-state-v1')).toHaveLength(1)
    expect(ghIssueListByLabelAsync).not.toHaveBeenCalled()
  })

  it('a label-only tranche with zero Issues is planned — absent from both active and archived', async () => {
    mockPages(MILESTONES, [{ name: 'vinaya/tranche:brand-new-v1' }])
    vi.mocked(ghIssueListByLabelAsync).mockResolvedValue([])

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active.some((r) => r.slug === 'brand-new-v1')).toBe(false)
    expect(index.archived.some((r) => r.slug === 'brand-new-v1')).toBe(false)
    expect(index.facts.get('brand-new-v1')).toEqual({ goal: '', lifecycle: 'planned' })
  })

  it('returns empty lists and no facts when the repo has no milestones or labels', async () => {
    mockPages(emptyMilestones, [])

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active).toEqual([])
    expect(index.archived).toEqual([])
    expect(index.facts.size).toBe(0)
    expect(index.legacySlugs.size).toBe(0)
  })
})

/**
 * Guards the pagination decision itself, not just its output. Milestones and
 * labels are both append-only in practice, so a single `per_page=100` page is
 * a countdown rather than a bound: the day a repo's 101st Milestone (or
 * label) is created, a non-paginated index starts omitting tranches from the
 * repo-wide sweep it is the enumeration authority for — silently, with no
 * error. Swapping this reader back to the single-page `ghApiGetAsync` is
 * therefore a real regression that no output-shape assertion above would
 * notice, since every fixture here is smaller than one page.
 */
describe('indexTrancheMilestonesAsync reads every page', () => {
  it('uses the paginated reader for both Milestones and labels, never the single-page one', async () => {
    vi.mocked(ghApiGetAllPagesAsync).mockResolvedValue([])
    vi.mocked(ghApiGetAsync).mockClear()

    await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(ghApiGetAllPagesAsync).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/milestones?state=all&per_page=100`)
    expect(ghApiGetAllPagesAsync).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/labels?per_page=100`)
    expect(ghApiGetAsync).not.toHaveBeenCalled()
  })

  it('indexes a legacy Milestone population larger than one page', async () => {
    // What the paginated reader returns once it has walked past page 1.
    const many = Array.from({ length: 137 }, (_, i) => ({
      title: `tranche-${i}`,
      description: null,
      state: i % 2 === 0 ? 'open' : 'closed'
    }))
    vi.mocked(ghApiGetAllPagesAsync).mockImplementation(async (path: string) => (path.includes('/labels') ? [] : many))

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.facts.size).toBe(137)
    expect(index.active).toHaveLength(69)
    expect(index.archived).toHaveLength(68)
    // The entries that only exist beyond the first page must be present, in
    // both lifecycles (even index ⇒ open ⇒ active, odd ⇒ closed ⇒ complete).
    expect(index.facts.get('tranche-136')).toEqual({ goal: '', lifecycle: 'active' })
    expect(index.facts.get('tranche-135')).toEqual({ goal: '', lifecycle: 'complete' })
  })
})
