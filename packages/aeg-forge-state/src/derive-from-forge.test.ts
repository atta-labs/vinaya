import { describe, expect, it, vi } from 'vitest'

vi.mock('./gh', () => ({
  ghApiGet: vi.fn(),
  ghIssueListByAnyLabelAsync: vi.fn()
}))

const { ghApiGet, ghIssueListByAnyLabelAsync } = await import('./gh')
const { deriveTrancheFromForge, trancheFromIssues } = await import('./derive-from-forge')

const OWNER = 'atta-labs'
const REPO = 'vinaya'
const SLUG = 'aeg-seam-hardening-v1'

const MILESTONES = [{ title: SLUG, description: 'Harden the seams.', state: 'open' }]

const ISSUES = [
  {
    number: 51,
    title: `[${SLUG}] 8 — A1 evaluation`,
    body: '**Project:** vinaya\n\n**Dependency rationale** — no `depends-on`.',
    state: 'OPEN' as const,
    labels: [{ name: `vinaya/tranche:${SLUG}` }],
    milestone: { title: SLUG }
  },
  {
    number: 52,
    title: `[${SLUG}] 9 — Stop verify-coherence failing on machine load`,
    body: '**Project:** vinaya\n\n**Dependency rationale** — no `depends-on`.',
    state: 'OPEN' as const,
    labels: [{ name: `vinaya/tranche:${SLUG}` }],
    milestone: { title: SLUG }
  }
]

/**
 * The invariant the repo-wide sweep in `verify-coherence.ts` rests on: composing
 * a tranche from already-fetched halves must produce exactly what the fetching
 * entry point produces. If these two ever diverge, the sweep's speed-up would be
 * bought with a changed verdict — the one thing task 9 was forbidden to do.
 */
describe('trancheFromIssues', () => {
  it('produces exactly what deriveTrancheFromForge produces for the same forge data', async () => {
    vi.mocked(ghApiGet).mockReturnValue(MILESTONES)
    vi.mocked(ghIssueListByAnyLabelAsync).mockResolvedValue(ISSUES)

    const fetched = await deriveTrancheFromForge(OWNER, REPO, SLUG)
    const composed = trancheFromIssues(SLUG, ISSUES, { goal: 'Harden the seams.', lifecycle: 'active' })

    expect(composed).toEqual(fetched)
  })

  it('issues no forge call of its own', () => {
    vi.mocked(ghApiGet).mockClear()
    vi.mocked(ghIssueListByAnyLabelAsync).mockClear()

    trancheFromIssues(SLUG, ISSUES, { goal: 'Harden the seams.', lifecycle: 'active' })

    expect(ghApiGet).not.toHaveBeenCalled()
    expect(ghIssueListByAnyLabelAsync).not.toHaveBeenCalled()
  })

  it('degrades exactly as the fetching path does when no Milestone exists for the slug', async () => {
    vi.mocked(ghApiGet).mockReturnValue([])
    vi.mocked(ghIssueListByAnyLabelAsync).mockResolvedValue(ISSUES)

    const fetched = await deriveTrancheFromForge(OWNER, REPO, SLUG)
    const composed = trancheFromIssues(SLUG, ISSUES, undefined)

    expect(composed).toEqual(fetched)
    expect(composed.goal).toBe('')
    expect(composed.lifecycle).toBe('active')
  })

  it('treats a null Milestone (an index miss) the same as an absent one', () => {
    expect(trancheFromIssues(SLUG, ISSUES, null)).toEqual(trancheFromIssues(SLUG, ISSUES, undefined))
  })

  it('always reports an empty backlog — the `## Backlog` section has no forge equivalent', () => {
    expect(trancheFromIssues(SLUG, ISSUES, null).backlog).toEqual([])
  })
})
