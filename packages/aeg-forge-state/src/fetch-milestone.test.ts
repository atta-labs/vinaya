import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGhMock } from './test-support/mock-gh'

vi.mock('./gh', () => createGhMock())

const { ghApiGet, ghApiGetAsync, ghApiGetAllPagesAsync, ghIssueListByLabel, ghIssueListByLabelAsync } = await import(
  './gh'
)
const {
  findMilestoneForSlug,
  hasExplicitMilestoneFlag,
  indexTrancheMilestonesAsync,
  listActiveTrancheSlugs,
  listArchivedTrancheSlugs,
  intentGoalForSlug,
  intentLines,
  milestoneLifecycleFromTrancheLifecycles,
  releaseFromDescription,
  resolveMilestoneAttachTarget
} = await import('./fetch-milestone')

const OWNER = 'daniboomerang'
const REPO = 'attalabs'
const FIXTURES = join(__dirname, '..', 'tests', 'fixtures')
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
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    expect(findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')).toEqual({
      goal: 'Migrate this repo governance state.',
      lifecycle: 'active'
    })
  })

  it('returns goal + complete lifecycle for a closed milestone with nothing live under its label', () => {
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'vinaya-cli-v1', description: 'Ship the CLI.', state: 'closed' }])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    expect(findMilestoneForSlug(OWNER, REPO, 'vinaya-cli-v1')).toEqual({
      goal: 'Ship the CLI.',
      lifecycle: 'complete'
    })
  })

  it('treats a missing description as an empty goal', () => {
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'aeg-forge-state-v1', description: null, state: 'open' }])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    expect(findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')).toEqual({ goal: '', lifecycle: 'active' })
  })

  it('a legacy Milestone with nothing under its label is trusted as-is, no override', () => {
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'aeg-forge-state-v1', description: null, state: 'open' }])
    vi.mocked(ghIssueListByLabel).mockClear()
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    const result = findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')

    expect(ghIssueListByLabel).toHaveBeenCalledTimes(1)
    expect(result?.lifecycle).toBe('active')
  })

  it('a slug retired via `vinaya milestone adopt` — legacy Milestone closed, real Issues live under the label — reads active from the label, not complete from the stale Milestone', () => {
    vi.mocked(ghApiGet).mockReturnValue([
      { title: 'vinaya-agentic-interface-v1', description: 'old goal', state: 'closed' }
    ])
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('OPEN'), issue('CLOSED')])

    expect(findMilestoneForSlug(OWNER, REPO, 'vinaya-agentic-interface-v1')).toEqual({
      goal: 'old goal',
      lifecycle: 'active'
    })
  })

  it('a closed legacy Milestone whose label Issues are ALL closed still reads complete — the label branch, not just the Milestone-state branch, must reach the same answer', () => {
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'finished-v1', description: 'Shipped.', state: 'closed' }])
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('CLOSED'), issue('CLOSED')])

    expect(findMilestoneForSlug(OWNER, REPO, 'finished-v1')).toEqual({ goal: 'Shipped.', lifecycle: 'complete' })
  })

  it('an OPEN legacy Milestone is never overridden by its label, even when the label Issues would otherwise resolve complete — the override is gated on closed, adopt never produces an open+labeled legacy Milestone', () => {
    vi.mocked(ghApiGet).mockReturnValue([
      { title: 'aeg-forge-state-v1', description: 'Migrate this repo governance state.', state: 'open' }
    ])
    // Stray manual labeling, or any state the real `adopt` write path never
    // produces — all-closed label Issues under a Milestone that is itself
    // still open. Without the `state === 'closed'` gate, this would wrongly
    // flip a genuinely active tranche to `complete`.
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('CLOSED'), issue('CLOSED')])

    expect(findMilestoneForSlug(OWNER, REPO, 'aeg-forge-state-v1')).toEqual({
      goal: 'Migrate this repo governance state.',
      lifecycle: 'active'
    })
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

  it('a label-derived tranche picks up its goal from the matching intent line in a non-legacy Milestone', () => {
    const description = [
      'Ship the milestone model.',
      '',
      '### Tranche intents',
      '- vinaya-milestone-model-v1: A milestone can be created and refused when malformed.'
    ].join('\n')
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'sprint-42', description, state: 'open' }])
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('OPEN')])

    expect(findMilestoneForSlug(OWNER, REPO, 'vinaya-milestone-model-v1')).toEqual({
      goal: 'A milestone can be created and refused when malformed.',
      lifecycle: 'active'
    })
  })

  it('a label with no matching intent line keeps the empty goal, exactly as before', () => {
    const description = ['Ship something else.', '', '### Tranche intents', '- other-slug: unrelated.'].join('\n')
    vi.mocked(ghApiGet).mockReturnValue([{ title: 'sprint-42', description, state: 'open' }])
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('OPEN')])

    expect(findMilestoneForSlug(OWNER, REPO, 'vinaya-milestone-model-v1')).toEqual({ goal: '', lifecycle: 'active' })
  })
})

describe('resolveMilestoneAttachTarget', () => {
  it('resolves an open legacy Milestone (title equals slug) by its own number + title', () => {
    const milestones = [{ number: 9, title: 'aeg-review-gate-v1', description: '', state: 'open' as const }]
    expect(resolveMilestoneAttachTarget(milestones, 'aeg-review-gate-v1')).toEqual({
      number: 9,
      title: 'aeg-review-gate-v1'
    })
  })

  it('returns null for a CLOSED legacy Milestone with no successor — never itself a valid --milestone target', () => {
    const milestones = [{ number: 3, title: 'vinaya-cli-v1', description: '', state: 'closed' as const }]
    expect(resolveMilestoneAttachTarget(milestones, 'vinaya-cli-v1')).toBeNull()
  })

  it('falls through to the intent-declared successor when the legacy match is closed — the `vinaya milestone adopt` shape (milestone-model.md §4), and the exact gap this function exists to close', () => {
    const successorDescription = [
      'Ship the Engine.',
      '',
      '### Tranche intents',
      '- vinaya-agentic-interface-v1: Real agent spawn.'
    ].join('\n')
    const milestones = [
      { number: 7, title: 'vinaya-agentic-interface-v1', description: 'old goal', state: 'closed' as const },
      { number: 13, title: 'Engine', description: successorDescription, state: 'open' as const }
    ]
    expect(resolveMilestoneAttachTarget(milestones, 'vinaya-agentic-interface-v1')).toEqual({
      number: 13,
      title: 'Engine'
    })
  })

  it('resolves an intent-declared Milestone by ITS OWN title — the bug this function exists to fix, since gh resolves --milestone by title, not slug', () => {
    const description = [
      'Ship the Engine.',
      '',
      '### Tranche intents',
      '- engine-agent-spawn-v1: Real agent spawn.'
    ].join('\n')
    const milestones = [{ number: 64, title: 'Engine', description, state: 'open' as const }]
    expect(resolveMilestoneAttachTarget(milestones, 'engine-agent-spawn-v1')).toEqual({ number: 64, title: 'Engine' })
  })

  it('never matches a CLOSED intent-declaring Milestone', () => {
    const description = [
      'Ship the Engine.',
      '',
      '### Tranche intents',
      '- engine-agent-spawn-v1: Real agent spawn.'
    ].join('\n')
    const milestones = [{ number: 64, title: 'Engine', description, state: 'closed' as const }]
    expect(resolveMilestoneAttachTarget(milestones, 'engine-agent-spawn-v1')).toBeNull()
  })

  it('prefers the legacy exact-title match over an intent-declared match, when somehow both exist', () => {
    const description = [
      'Sprint goal.',
      '',
      '### Tranche intents',
      '- aeg-review-gate-v1: unrelated intent line.'
    ].join('\n')
    const milestones = [
      { number: 1, title: 'sprint-42', description, state: 'open' as const },
      { number: 9, title: 'aeg-review-gate-v1', description: '', state: 'open' as const }
    ]
    expect(resolveMilestoneAttachTarget(milestones, 'aeg-review-gate-v1')).toEqual({
      number: 9,
      title: 'aeg-review-gate-v1'
    })
  })

  it('returns null when nothing — legacy or intent-declared — matches the slug at all', () => {
    const milestones = [{ number: 1, title: 'sprint-42', description: 'Just a sprint.', state: 'open' as const }]
    expect(resolveMilestoneAttachTarget(milestones, 'brand-new-tranche')).toBeNull()
  })

  it('picks the first OPEN intent-declaring Milestone when more than one somehow declares the same slug', () => {
    const desc = (s: string) => `### Tranche intents\n- ${s}: intent.`
    const milestones = [
      { number: 1, title: 'sprint-41', description: desc('engine-agent-spawn-v1'), state: 'open' as const },
      { number: 2, title: 'sprint-42', description: desc('engine-agent-spawn-v1'), state: 'open' as const }
    ]
    expect(resolveMilestoneAttachTarget(milestones, 'engine-agent-spawn-v1')).toEqual({ number: 1, title: 'sprint-41' })
  })
})

describe('hasExplicitMilestoneFlag', () => {
  it('is true for a bare --milestone flag', () => {
    expect(hasExplicitMilestoneFlag(['--title', 't', '--milestone', 'x'])).toBe(true)
  })

  it('is true for the -m short flag', () => {
    expect(hasExplicitMilestoneFlag(['-m', 'x'])).toBe(true)
  })

  it('is true for the --milestone=<value> inline-equals form', () => {
    expect(hasExplicitMilestoneFlag(['--milestone=x'])).toBe(true)
  })

  it('is false when no milestone flag is present', () => {
    expect(hasExplicitMilestoneFlag(['--title', 't'])).toBe(false)
  })
})

describe('releaseFromDescription', () => {
  it('returns null when no Release: field exists', () => {
    expect(releaseFromDescription('A milestone with no version.')).toBeNull()
  })

  it('reads a bold-inline Release: field', () => {
    expect(releaseFromDescription('The goal.\n\n**Release:** 1.2.0')).toBe('1.2.0')
  })

  it('reads a plain Release: field', () => {
    expect(releaseFromDescription('The goal.\n\nRelease: 1.2.0')).toBe('1.2.0')
  })

  it('returns null for a malformed version', () => {
    expect(releaseFromDescription('Release: whenever it ships')).toBeNull()
  })

  it('never matches inside a fenced code example', () => {
    const body = ['The goal.', '', '```', 'Release: 1.0.0', '```', ''].join('\n')
    expect(releaseFromDescription(body)).toBeNull()
  })
})

describe('intentGoalForSlug', () => {
  it('returns empty string when there is no Tranche intents section', () => {
    expect(intentGoalForSlug('Just a goal, no intents.', 'some-slug')).toBe('')
  })

  it('returns the matching intent line', () => {
    const description = ['Ship the milestone model.', '', '### Tranche intents', '- a-slug: Its intent text.'].join(
      '\n'
    )
    expect(intentGoalForSlug(description, 'a-slug')).toBe('Its intent text.')
  })

  it('returns empty string when the section exists but no line matches this slug', () => {
    const description = ['Goal.', '', '### Tranche intents', '- other-slug: unrelated.'].join('\n')
    expect(intentGoalForSlug(description, 'a-slug')).toBe('')
  })
})

describe('intentLines', () => {
  it('returns an empty array when there is no Tranche intents section', () => {
    expect(intentLines('Just a goal, no intents.')).toEqual([])
  })

  it('returns every bullet, in source order, lowercasing the slug', () => {
    const description = [
      'Ship the milestone model.',
      '',
      '### Tranche intents',
      '- plan-brief-v1: the brief is a function of the task Issue. (complete 2026-09-09)',
      '- Review-Validity-v1: a verdict binds to everything it judged.'
    ].join('\n')
    expect(intentLines(description)).toEqual([
      { slug: 'plan-brief-v1', goal: 'the brief is a function of the task Issue. (complete 2026-09-09)' },
      { slug: 'review-validity-v1', goal: 'a verdict binds to everything it judged.' }
    ])
  })

  it("skips a non-bullet line rather than refusing — malformed-body rejection is checkMilestoneShape's job, not this reader's", () => {
    const description = ['Goal.', '', '### Tranche intents', 'not a bullet at all', '- a-slug: real one.'].join('\n')
    expect(intentLines(description)).toEqual([{ slug: 'a-slug', goal: 'real one.' }])
  })

  it('returns an empty array when the section heading exists but declares no bullets', () => {
    const description = ['Goal.', '', '### Tranche intents', '', '## Next section', 'prose'].join('\n')
    expect(intentLines(description)).toEqual([])
  })

  it("stops at the next heading, matching intentGoalForSlug's own section boundary", () => {
    const description = [
      'Goal.',
      '',
      '### Tranche intents',
      '- a-slug: in section.',
      '',
      '## Not intents',
      '- b-slug: outside the section, must not be read.'
    ].join('\n')
    expect(intentLines(description)).toEqual([{ slug: 'a-slug', goal: 'in section.' }])
  })
})

describe('milestoneLifecycleFromTrancheLifecycles', () => {
  it('derives planned when the milestone holds zero tranches — the at-least-one guard, one altitude up', () => {
    expect(milestoneLifecycleFromTrancheLifecycles([])).toBe('planned')
  })

  it('derives planned when every declared tranche is itself still planned', () => {
    expect(milestoneLifecycleFromTrancheLifecycles(['planned', 'planned'])).toBe('planned')
  })

  it('derives active when any tranche is active', () => {
    expect(milestoneLifecycleFromTrancheLifecycles(['planned', 'active'])).toBe('active')
  })

  it('derives complete only when every tranche is complete', () => {
    expect(milestoneLifecycleFromTrancheLifecycles(['complete', 'complete'])).toBe('complete')
  })

  it('derives active for a mix of complete and planned — not yet fully done', () => {
    expect(milestoneLifecycleFromTrancheLifecycles(['complete', 'planned'])).toBe('active')
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
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual(
      expect.arrayContaining([
        { slug: 'aeg-forge-state-v1', goal: 'Migrate this repo governance state.' },
        { slug: 'herald-hardening-v1', goal: '' }
      ])
    )
  })

  it('requests the full state=all Milestone set, plus the label set — not the state=open-only set', () => {
    mockGh([], [])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])
    listActiveTrancheSlugs(OWNER, REPO)
    expect(ghApiGet).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/milestones?state=all&per_page=100`)
    expect(ghApiGet).toHaveBeenCalledWith(`repos/${OWNER}/${REPO}/labels?per_page=100`)
  })

  it('returns an empty list when nothing is open or active (the real, current fixture)', () => {
    mockGh(emptyMilestones, [])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])
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

  it('a closed legacy Milestone with nothing under its label stays complete, not active', () => {
    mockGh([{ title: 'shipped-v1', description: 'Done.', state: 'closed' }], ['vinaya/tranche:shipped-v1'])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([])
  })

  it('a closed legacy Milestone retired via `vinaya milestone adopt` — real open Issues live under its label — resolves active, not the stale closed Milestone', () => {
    mockGh(
      [{ title: 'vinaya-agentic-interface-v1', description: 'old goal', state: 'closed' }],
      ['vinaya/tranche:vinaya-agentic-interface-v1']
    )
    vi.mocked(ghIssueListByLabel).mockReturnValue([issue('OPEN')])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([{ slug: 'vinaya-agentic-interface-v1', goal: 'old goal' }])
  })

  it('a free-text-titled Architect Milestone is never listed as a phantom tranche', () => {
    // vinaya-milestone-model-v1 task 2: an Architect Milestone's title is
    // free text, not a tranche slug. Before the shape guard, EVERY
    // Milestone's title fed the candidate-slug set, so this title
    // trivially legacy-matched itself and was listed as a fake tranche.
    mockGh([{ title: 'Vinaya milestone model — Test Plan proof', description: 'The goal.', state: 'open' }], [])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([])
  })

  it('a single-word, mixed-case free-text title is also never listed as a phantom tranche', () => {
    // Code review round 2: the shape guard first shipped by reusing
    // PROJECT_SLUG, whose `i` flag matches capital letters — so a one-word
    // title with no space and no dash ("MilestoneModel", "Vinaya") slipped
    // through and still phantom-matched. Every real tranche slug in this
    // repo is lowercase, so the guard must be case-sensitive.
    mockGh([{ title: 'MilestoneModel', description: 'The goal.', state: 'open' }], [])

    expect(listActiveTrancheSlugs(OWNER, REPO)).toEqual([])
  })

  it('a lowercase, hyphenated free-text title with no version suffix is also never listed as a phantom tranche', () => {
    // Code review round 3: a plausible kebab-case product-goal title
    // ("improve-onboarding-flow") still phantom-matched, since every real
    // tranche slug is ALSO lowercase and hyphenated — the shape guard needed
    // one more property that distinguishes them: every real slug in this
    // repo ends in a `-v<N>` version suffix, which an ordinary free-text
    // title is unlikely to carry by accident.
    mockGh([{ title: 'improve-onboarding-flow', description: 'A product goal, not a tranche.', state: 'open' }], [])

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

  it('maps every closed legacy milestone with nothing under its label to its slug + goal', () => {
    mockGh([{ title: 'vinaya-cli-v1', description: 'Ship the CLI.', state: 'closed' }], [])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

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

  it('a free-text-titled Architect Milestone is never listed as a phantom archived tranche', () => {
    mockGh([{ title: 'Vinaya milestone model — Test Plan proof', description: 'The goal.', state: 'closed' }], [])

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
    vi.mocked(ghIssueListByLabelAsync).mockResolvedValue([])

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
    vi.mocked(ghIssueListByLabelAsync).mockResolvedValue([])
    vi.mocked(ghIssueListByLabel).mockReturnValue([])

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
    vi.mocked(ghIssueListByLabelAsync).mockResolvedValue([])

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.facts.get('no-such-slug')).toBeUndefined()
    expect(findMilestoneForSlug(OWNER, REPO, 'no-such-slug')).toEqual({ goal: '', lifecycle: 'planned' })
  })

  it('folds in a label-only tranche (no matching Milestone at all), fetched exactly once by that slug', async () => {
    mockPages(MILESTONES, [{ name: 'vinaya/tranche:label-only-v1' }])
    vi.mocked(ghIssueListByLabelAsync).mockClear()
    vi.mocked(ghIssueListByLabelAsync).mockImplementation(async (_o, _r, label: string) =>
      label === 'vinaya/tranche:label-only-v1' ? [issue('OPEN'), issue('CLOSED')] : []
    )

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active).toContainEqual({ slug: 'label-only-v1', goal: '' })
    expect(index.legacySlugs.has('label-only-v1')).toBe(false)
    const labelOnlyCalls = vi
      .mocked(ghIssueListByLabelAsync)
      .mock.calls.filter(([, , label]) => label === 'vinaya/tranche:label-only-v1')
    expect(labelOnlyCalls).toHaveLength(1)
  })

  it('a label matching a legacy slug is fetched exactly once, and a live open Issue under it overrides a stale-closed legacy Milestone', async () => {
    mockPages(MILESTONES, [{ name: 'vinaya/tranche:vinaya-cli-v1' }])
    vi.mocked(ghIssueListByLabelAsync).mockClear()
    // `vinaya-cli-v1` legacy-matches a CLOSED Milestone in `MILESTONES` — before
    // this fix that alone made it `complete` forever. A live open Issue under
    // its label (the post-`adopt` shape) must override that stale read.
    vi.mocked(ghIssueListByLabelAsync).mockImplementation(async (_o, _r, label: string) =>
      label === 'vinaya/tranche:vinaya-cli-v1' ? [issue('OPEN')] : []
    )

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.active).toContainEqual({ slug: 'vinaya-cli-v1', goal: 'Ship the CLI.' })
    expect(index.archived.filter((r) => r.slug === 'vinaya-cli-v1')).toHaveLength(0)
    const cliCalls = vi
      .mocked(ghIssueListByLabelAsync)
      .mock.calls.filter(([, , label]) => label === 'vinaya/tranche:vinaya-cli-v1')
    expect(cliCalls).toHaveLength(1)
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

  it('a free-text-titled Architect Milestone is never indexed as a phantom tranche', async () => {
    // vinaya-milestone-model-v1 task 2: before the shape guard, every real
    // Milestone in the paginated fetch was unconditionally treated as a
    // legacy tranche (`legacySlugs = new Set(milestones.map(m => m.title))`,
    // no `matchesLegacyMilestone` gate at all in this async path) — so an
    // Architect's free-text-titled goal Milestone landed in `active`/`archived`
    // with its raw description as the "goal".
    mockPages(
      [...MILESTONES, { title: 'Vinaya milestone model — Test Plan proof', description: 'The goal.', state: 'open' }],
      []
    )
    vi.mocked(ghIssueListByLabelAsync).mockResolvedValue([])

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    const phantomSlug = 'Vinaya milestone model — Test Plan proof'
    expect(index.legacySlugs.has(phantomSlug)).toBe(false)
    expect(index.active.some((r) => r.slug === phantomSlug)).toBe(false)
    expect(index.archived.some((r) => r.slug === phantomSlug)).toBe(false)
    expect(index.facts.has(phantomSlug)).toBe(false)
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
    // Titled `tranche-N-v1` (not bare `tranche-N`) so this fixture still
    // matches TRANCHE_SLUG_SHAPE now that it requires the `-v<N>` suffix
    // every real legacy Milestone title in this repo actually carries
    // (round 3 code review) — the pagination behaviour under test is
    // unaffected by the title shape.
    const many = Array.from({ length: 137 }, (_, i) => ({
      title: `tranche-${i}-v1`,
      description: null,
      state: i % 2 === 0 ? 'open' : 'closed'
    }))
    vi.mocked(ghApiGetAllPagesAsync).mockImplementation(async (path: string) => (path.includes('/labels') ? [] : many))
    vi.mocked(ghIssueListByLabelAsync).mockResolvedValue([])

    const index = await indexTrancheMilestonesAsync(OWNER, REPO)

    expect(index.facts.size).toBe(137)
    expect(index.active).toHaveLength(69)
    expect(index.archived).toHaveLength(68)
    // The entries that only exist beyond the first page must be present, in
    // both lifecycles (even index ⇒ open ⇒ active, odd ⇒ closed ⇒ complete).
    expect(index.facts.get('tranche-136-v1')).toEqual({ goal: '', lifecycle: 'active' })
    expect(index.facts.get('tranche-135-v1')).toEqual({ goal: '', lifecycle: 'complete' })
  })
})
