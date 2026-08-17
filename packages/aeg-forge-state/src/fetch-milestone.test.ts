import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./gh', () => ({
  ghApiGet: vi.fn(),
  ghApiGetAsync: vi.fn(),
  ghApiGetAllPagesAsync: vi.fn()
}))

const { ghApiGet, ghApiGetAsync, ghApiGetAllPagesAsync } = await import('./gh')
const { findMilestoneForSlug, indexTrancheMilestonesAsync, listActiveTrancheSlugs } = await import('./fetch-milestone')

const OWNER = 'daniboomerang'
const REPO = 'attalabs'
const FIXTURES = join(__dirname, 'fixtures')
/** Captured live 2026-07-06 via `gh api repos/daniboomerang/attalabs/milestones?state=all` —
 * the real, current state: no Milestone exists yet for any active tranche. */
const emptyMilestones = JSON.parse(readFileSync(join(FIXTURES, 'milestones-empty.json'), 'utf8'))

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

  it('returns null when no milestone matches the slug (the real, current fixture — no Milestone exists yet for any active tranche)', () => {
    vi.mocked(ghApiGet).mockReturnValue(emptyMilestones)

    expect(findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')).toBeNull()
  })
})

describe('listActiveTrancheSlugs', () => {
  it('maps every open milestone to its slug + goal', () => {
    vi.mocked(ghApiGet).mockReturnValue([
      { title: 'aeg-forge-state-v1', description: 'Migrate this repo governance state.', state: 'open' },
      { title: 'herald-hardening-v1', description: null, state: 'open' }
    ])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([
      { slug: 'aeg-forge-state-v1', goal: 'Migrate this repo governance state.' },
      { slug: 'herald-hardening-v1', goal: '' }
    ])
  })

  it('requests only open milestones, not the full state=all set', () => {
    vi.mocked(ghApiGet).mockReturnValue([])
    listActiveTrancheSlugs(OWNER, REPO)
    expect(ghApiGet).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/milestones?state=open&per_page=100`)
  })

  it('returns an empty list when no milestones are open (the real, current fixture)', () => {
    vi.mocked(ghApiGet).mockReturnValue(emptyMilestones)
    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([])
  })
})

describe('indexTrancheMilestonesAsync', () => {
  const MILESTONES = [
    { title: 'aeg-forge-state-v1', description: 'Migrate this repo governance state.', state: 'open' },
    { title: 'herald-hardening-v1', description: null, state: 'open' },
    { title: 'vinaya-cli-v1', description: 'Ship the CLI.', state: 'closed' }
  ]

  it('splits one state=all response into the active and archived lists', async () => {
    vi.mocked(ghApiGetAllPagesAsync).mockResolvedValue(MILESTONES)

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active).toEqual([
      { slug: 'aeg-forge-state-v1', goal: 'Migrate this repo governance state.' },
      { slug: 'herald-hardening-v1', goal: '' }
    ])
    expect(index.archived).toEqual([{ slug: 'vinaya-cli-v1', goal: 'Ship the CLI.' }])
  })

  it('yields, per slug, exactly what findMilestoneForSlug returns for the same data', async () => {
    vi.mocked(ghApiGetAllPagesAsync).mockResolvedValue(MILESTONES)
    vi.mocked(ghApiGet).mockReturnValue(MILESTONES)

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    for (const slug of ['aeg-forge-state-v1', 'herald-hardening-v1', 'vinaya-cli-v1', 'no-such-slug']) {
      expect(index.facts.get(slug) ?? null).toEqual(findMilestoneForSlug(OWNER, REPO, slug))
    }
  })

  it('costs exactly one round trip regardless of how many slugs are read from it', async () => {
    vi.mocked(ghApiGetAllPagesAsync).mockResolvedValue(MILESTONES)
    vi.mocked(ghApiGetAllPagesAsync).mockClear()

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)
    for (const m of MILESTONES) index.facts.get(m.title)

    expect(ghApiGetAllPagesAsync).toHaveBeenCalledTimes(1)
    expect(ghApiGetAllPagesAsync).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/milestones?state=all&per_page=100`)
  })

  it('returns empty lists and no facts when the repo has no milestones', async () => {
    vi.mocked(ghApiGetAllPagesAsync).mockResolvedValue(emptyMilestones)

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active).toEqual([])
    expect(index.archived).toEqual([])
    expect(index.facts.size).toBe(0)
  })
})

/**
 * Guards the pagination decision itself, not just its output. Milestones are
 * append-only, so a single `per_page=100` page is a countdown rather than a
 * bound: the day a repo's 101st Milestone is created, a non-paginated index
 * starts omitting tranches from the repo-wide sweep it is the enumeration
 * authority for — silently, with no error. Swapping this reader back to the
 * single-page `ghApiGetAsync` is therefore a real regression that no
 * output-shape assertion above would notice, since every fixture here is
 * smaller than one page.
 */
describe('indexTrancheMilestonesAsync reads every page', () => {
  it('uses the paginated reader, never the single-page one', async () => {
    vi.mocked(ghApiGetAllPagesAsync).mockResolvedValue([])
    vi.mocked(ghApiGetAsync).mockClear()

    await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(ghApiGetAllPagesAsync).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/milestones?state=all&per_page=100`)
    expect(ghApiGetAsync).not.toHaveBeenCalled()
  })

  it('indexes a result larger than one page', async () => {
    // What the paginated reader returns once it has walked past page 1.
    const many = Array.from({ length: 137 }, (_, i) => ({
      title: `tranche-${i}`,
      description: null,
      state: i % 2 === 0 ? 'open' : 'closed'
    }))
    vi.mocked(ghApiGetAllPagesAsync).mockResolvedValue(many)

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
