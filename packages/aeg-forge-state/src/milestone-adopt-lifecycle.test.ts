import { describe, expect, it, vi } from 'vitest'
import { createGhMock } from './test-support/mock-gh'

vi.mock('./gh', () => createGhMock())

const { ghApiGet, ghApiGetAllPagesAsync, ghIssueListByLabel, ghIssueListByLabelAsync } = await import('./gh')
const { findMilestoneForSlug, indexTrancheMilestonesAsync, listActiveTrancheSlugs, listArchivedTrancheSlugs } =
  await import('./fetch-milestone')

const OWNER = 'daniboomerang'
const REPO = 'attalabs'

/**
 * Integration coverage for the seam a real regression fixed: `apps/cli`'s
 * `milestone adopt` (the write side) versus `fetch-milestone.ts`'s four
 * readers (the read side). That regression's root cause was that both sides
 * shipped with their own passing unit tests, in isolation, and nobody
 * exercised the sequence that actually happens live — `adopt` runs, then a
 * reader is asked about that slug. This file is that sequence, once,
 * against every reader.
 *
 * Not a re-test of `resolveLegacyFacts` in isolation — `fetch-milestone.test.ts`
 * already covers that exhaustively. This file never imports or re-implements
 * `apps/cli/src/commands/milestone.ts` (this package sits below `apps/cli`
 * in the dependency graph and cannot import it); instead `simulateAdopt`
 * below reproduces its write side effects — reattach every labeled Issue's
 * milestone, then close the old one — in the same order `milestoneAdoptCommand`
 * performs them, against a single shared mutable forge fixture every reader
 * in this file reads from.
 */

type Milestone = { title: string; description: string | null; state: 'open' | 'closed' }
type Issue = {
  number: number
  title: string
  body: string | null
  state: 'OPEN' | 'CLOSED'
  labels: Array<{ name: string }>
  milestone: { title: string } | null
}

/** A realistic pre-adopt forge: a 1:1 legacy Milestone, open, holding this tranche's Issues both natively and via its label — the shape every real pre-`adopt` tranche in this repo has. */
function makeForge() {
  const milestones: Milestone[] = []
  const issues: Issue[] = []
  return { milestones, issues }
}

function addLegacyMilestone(forge: ReturnType<typeof makeForge>, slug: string, description: string): Milestone {
  const m: Milestone = { title: slug, description, state: 'open' }
  forge.milestones.push(m)
  return m
}

function addTargetMilestone(forge: ReturnType<typeof makeForge>, title: string, description: string): Milestone {
  const m: Milestone = { title, description, state: 'open' }
  forge.milestones.push(m)
  return m
}

let nextIssueNumber = 100
function addLabeledIssue(forge: ReturnType<typeof makeForge>, slug: string, state: 'OPEN' | 'CLOSED'): Issue {
  const issue: Issue = {
    number: nextIssueNumber++,
    title: `task ${nextIssueNumber}`,
    body: '',
    state,
    labels: [{ name: `vinaya/tranche:${slug}` }],
    milestone: { title: slug }
  }
  forge.issues.push(issue)
  return issue
}

/**
 * Reproduces `milestoneAdoptCommand`'s write phase (`apps/cli/src/commands/milestone.ts`)
 * against the shared fixture, in the same order: every one of the slug's
 * labeled Issues gets reattached to `target` first, THEN the old legacy
 * Milestone is closed — never deleted, matching `adopt`'s own real write.
 */
function simulateAdopt(forge: ReturnType<typeof makeForge>, slug: string, target: string) {
  const label = `vinaya/tranche:${slug}`
  for (const issue of forge.issues) {
    if (issue.labels.some((l) => l.name === label)) issue.milestone = { title: target }
  }
  const legacy = forge.milestones.find((m) => m.title === slug)
  if (legacy && legacy.state !== 'closed') legacy.state = 'closed'
}

/** Wires every mocked `./gh` export to read live off `forge`'s current (mutable) state. */
function wireGhMocksToForge(forge: ReturnType<typeof makeForge>) {
  vi.mocked(ghApiGet).mockImplementation((path: string) => {
    if (path.includes('/labels')) {
      const names = new Set(forge.issues.flatMap((i) => i.labels.map((l) => l.name)))
      return [...names].map((name) => ({ name }))
    }
    return forge.milestones
  })
  vi.mocked(ghApiGetAllPagesAsync).mockImplementation(async (path: string) => {
    if (path.includes('/labels')) {
      const names = new Set(forge.issues.flatMap((i) => i.labels.map((l) => l.name)))
      return [...names].map((name) => ({ name }))
    }
    return forge.milestones
  })
  const byLabel = (label: string) => forge.issues.filter((i) => i.labels.some((l) => l.name === label))
  vi.mocked(ghIssueListByLabel).mockImplementation((_owner, _repo, label: string) => byLabel(label))
  vi.mocked(ghIssueListByLabelAsync).mockImplementation(async (_owner, _repo, label: string) => byLabel(label))
}

describe('milestone adopt → reader round trip (the #205 seam)', () => {
  it('a retired legacy Milestone with real open Issues moved to a different, still-open target reads active — not the stale closed Milestone — across every reader', async () => {
    const slug = 'atta-labs-onboarding-v1'
    const target = 'Flows become files'
    const forge = makeForge()
    addLegacyMilestone(forge, slug, 'Ship the onboarding flow.')
    addTargetMilestone(forge, target, 'Q3 delivery bucket.')
    addLabeledIssue(forge, slug, 'OPEN')
    addLabeledIssue(forge, slug, 'OPEN')
    addLabeledIssue(forge, slug, 'CLOSED')

    simulateAdopt(forge, slug, target)

    // Post-adopt fixture shape, asserted directly: the bug's exact precondition.
    const legacy = forge.milestones.find((m) => m.title === slug)
    expect(legacy?.state).toBe('closed')
    expect(forge.issues.every((i) => i.milestone?.title === target)).toBe(true)

    wireGhMocksToForge(forge)

    expect(findMilestoneForSlug(OWNER, REPO, slug)).toEqual({
      goal: 'Ship the onboarding flow.',
      lifecycle: 'active'
    })
    expect(listActiveTrancheSlugs(OWNER, REPO)).toContainEqual({ slug, goal: 'Ship the onboarding flow.' })
    expect(listArchivedTrancheSlugs(OWNER, REPO).some((r) => r.slug === slug)).toBe(false)

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)
    expect(index.facts.get(slug)).toEqual({ goal: 'Ship the onboarding flow.', lifecycle: 'active' })
    expect(index.active).toContainEqual({ slug, goal: 'Ship the onboarding flow.' })
    expect(index.archived.some((r) => r.slug === slug)).toBe(false)
    expect(index.legacySlugs.has(slug)).toBe(true)
  })

  it('a retired legacy Milestone whose real Issues are now ALL closed under the target reads complete — the round trip derives the tranche’s true current state, not just always-active', async () => {
    const slug = 'atta-labs-shipped-v1'
    const target = 'Flows become files'
    const forge = makeForge()
    addLegacyMilestone(forge, slug, 'Ship the thing.')
    addTargetMilestone(forge, target, 'Q3 delivery bucket.')
    addLabeledIssue(forge, slug, 'CLOSED')
    addLabeledIssue(forge, slug, 'CLOSED')

    simulateAdopt(forge, slug, target)
    wireGhMocksToForge(forge)

    expect(findMilestoneForSlug(OWNER, REPO, slug)).toEqual({ goal: 'Ship the thing.', lifecycle: 'complete' })
    expect(listArchivedTrancheSlugs(OWNER, REPO)).toContainEqual({ slug, goal: 'Ship the thing.' })
    expect(listActiveTrancheSlugs(OWNER, REPO).some((r) => r.slug === slug)).toBe(false)

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)
    expect(index.facts.get(slug)).toEqual({ goal: 'Ship the thing.', lifecycle: 'complete' })
    expect(index.archived).toContainEqual({ slug, goal: 'Ship the thing.' })
    expect(index.active.some((r) => r.slug === slug)).toBe(false)
  })

  it('before adopt runs, the same legacy Milestone reads from its own open state — the round trip is a real state transition, not a fixture that was already active', () => {
    const slug = 'atta-labs-preadopt-v1'
    const forge = makeForge()
    addLegacyMilestone(forge, slug, 'Not yet adopted.')
    addLabeledIssue(forge, slug, 'OPEN')

    wireGhMocksToForge(forge)

    expect(findMilestoneForSlug(OWNER, REPO, slug)).toEqual({ goal: 'Not yet adopted.', lifecycle: 'active' })

    simulateAdopt(forge, slug, 'Flows become files')
    wireGhMocksToForge(forge)

    expect(findMilestoneForSlug(OWNER, REPO, slug)).toEqual({ goal: 'Not yet adopted.', lifecycle: 'active' })
  })
})
