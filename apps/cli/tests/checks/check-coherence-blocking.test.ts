import { describe, expect, it } from 'bun:test'
import type { GhIssue, SlugMilestoneIndex } from '@attalabs/aeg-forge-state'
import type { TaskEntry } from '@attalabs/aeg-core'
import { evaluateA2, evaluateBranchL5, sweepOtherTranchesL5 } from '../../src/checks/bin/check-coherence'

const SLUG = 'branch-tranche-v1'
const AFTER_CUTOFF = '2026-08-01T00:00:00Z'
const BEFORE_CUTOFF = '2026-01-01T00:00:00Z'

function entry(
  id: string,
  issue: number | null,
  facts: { issueState: 'open' | 'closed'; prState?: 'none' | 'open' | 'merged'; mergedAt?: string | null }
): TaskEntry {
  return {
    trancheSlug: SLUG,
    archived: false,
    task: { id, title: `task ${id}`, issue, projects: [], dependsOn: [], conflictsWith: [], rationaleMarkdown: '' },
    facts: {
      issueState: facts.issueState,
      assigned: false,
      branchExists: false,
      prState: facts.prState ?? 'none',
      reviewDecision: 'none',
      blockedLabel: false,
      stateReason: facts.issueState === 'closed' ? 'completed' : null,
      closedAt: null,
      mergedAt: facts.mergedAt ?? null,
      closedByActor: null
    }
  }
}

function index(opts: { active?: string[]; otherOpenLegacySlugs?: string[] } = {}): SlugMilestoneIndex {
  return {
    active: (opts.active ?? []).map((slug) => ({ slug, goal: '' })),
    archived: [],
    facts: new Map(),
    legacySlugs: new Set(),
    otherOpenLegacySlugs: opts.otherOpenLegacySlugs ?? []
  }
}

function ghIssue(slug: string, id: number, state: 'OPEN' | 'CLOSED'): GhIssue {
  return {
    number: 100 + id,
    title: `[${slug}] ${id} — a task`,
    body: '',
    state,
    labels: [],
    milestone: null
  } as GhIssue
}

const merged = (id: string, issue: number, mergedAt = AFTER_CUTOFF) =>
  entry(id, issue, { issueState: 'closed', prState: 'merged', mergedAt })

describe('evaluateA2 (branch tranche, blocking)', () => {
  it('fails for a closed task merged on or after the cutoff whose PR carries no provenance', async () => {
    const result = await evaluateA2(
      SLUG,
      [merged('1', 11), merged('2', 12)],
      'tok',
      async () =>
        new Map([
          [11, true],
          [12, false]
        ])
    )
    expect(result.status).toBe('fail')
    expect(result.failures.map((f) => [f.code, f.issue])).toEqual([['archived-without-provenance', 12]])
  })

  it('stays grandfathered (never fail) for a merge before the cutoff', async () => {
    const result = await evaluateA2(SLUG, [merged('1', 11, BEFORE_CUTOFF)], 'tok', async () => new Map([[11, false]]))
    expect(result.status).toBe('info')
  })

  it('passes when every candidate carries provenance', async () => {
    const result = await evaluateA2(SLUG, [merged('1', 11)], 'tok', async () => new Map([[11, true]]))
    expect(result.status).toBe('pass')
  })

  it('reads only closed tasks whose closing PR merged', async () => {
    const asked: number[][] = []
    await evaluateA2(
      SLUG,
      [
        merged('1', 11),
        entry('2', 12, { issueState: 'open', prState: 'open' }),
        entry('3', 13, { issueState: 'closed', prState: 'none' })
      ],
      'tok',
      async (nums) => {
        asked.push(nums)
        return new Map([[11, true]])
      }
    )
    expect(asked).toEqual([[11]])
  })

  it('fails as severity:infra when the provenance read returns an empty map', async () => {
    const result = await evaluateA2(SLUG, [merged('1', 11), merged('2', 12)], 'tok', async () => new Map())
    expect(result.status).toBe('fail')
    expect(result.failures.map((f) => [f.code, f.issue])).toEqual([
      ['forge-read-unavailable', 11],
      ['forge-read-unavailable', 12]
    ])
    expect(result.failures[0]?.reason).toContain('severity:infra')
  })

  it('fails as severity:infra on any candidate the read gave no answer for', async () => {
    const result = await evaluateA2(SLUG, [merged('1', 11), merged('2', 12)], 'tok', async () => new Map([[11, true]]))
    expect(result.failures.map((f) => [f.code, f.issue])).toEqual([['forge-read-unavailable', 12]])
  })

  it('fails as severity:infra with no token, without reading', async () => {
    let reads = 0
    const result = await evaluateA2(SLUG, [merged('1', 11)], '', async () => {
      reads++
      return new Map([[11, true]])
    })
    expect(reads).toBe(0)
    expect(result.status).toBe('fail')
    expect(result.failures[0]?.code).toBe('forge-read-unavailable')
  })

  it('needs neither a token nor a read when no task is closed and merged', async () => {
    const result = await evaluateA2(SLUG, [entry('1', 11, { issueState: 'open' })], '', async () => {
      throw new Error('must not read')
    })
    expect(result.status).toBe('pass')
  })
})

describe('evaluateBranchL5 (branch tranche, blocking)', () => {
  it('fails when the branch tranche is active and every task Issue is closed', () => {
    const result = evaluateBranchL5(SLUG, index({ active: [SLUG] }), [merged('1', 11), merged('2', 12)])
    expect(result.status).toBe('fail')
    expect(result.failures.map((f) => [f.code, f.tranche])).toEqual([['tranche-not-archived', SLUG]])
  })

  it('passes while any task Issue is open', () => {
    const result = evaluateBranchL5(SLUG, index({ active: [SLUG] }), [
      merged('1', 11),
      entry('2', 12, { issueState: 'open' })
    ])
    expect(result.status).toBe('pass')
  })

  it('passes when the branch tranche is not active in the index', () => {
    expect(evaluateBranchL5(SLUG, index(), [merged('1', 11)]).status).toBe('pass')
  })

  it('judges only the branch tranche, never another active tranche', () => {
    const result = evaluateBranchL5(SLUG, index({ active: [SLUG, 'other-v1'] }), [
      entry('1', 11, { issueState: 'open' })
    ])
    expect(result.status).toBe('pass')
  })
})

describe('sweepOtherTranchesL5 (other tranches, report-only)', () => {
  const OTHER_DONE = 'other-done-v1'
  const OTHER_OPEN = 'other-open-v2'
  const LABEL_ONLY = 'label-only-v1'

  it('reads one Issue list per other open legacy slug, and none for the branch or a label-only slug', async () => {
    const reads: string[] = []
    const fixture = index({ active: [SLUG, LABEL_ONLY], otherOpenLegacySlugs: [OTHER_DONE, OTHER_OPEN] })
    const sweep = await sweepOtherTranchesL5(fixture, async (slug) => {
      reads.push(slug)
      return slug === OTHER_DONE
        ? [ghIssue(slug, 1, 'CLOSED'), ghIssue(slug, 2, 'CLOSED')]
        : [ghIssue(slug, 1, 'CLOSED'), ghIssue(slug, 2, 'OPEN')]
    })
    expect(reads.sort()).toEqual([OTHER_DONE, OTHER_OPEN])
    expect(sweep.result.failures.map((f) => [f.code, f.tranche])).toEqual([['tranche-not-archived', OTHER_DONE]])
    expect(sweep.unevaluated).toEqual([])
  })

  it('names a slug whose Issue-list read failed as not evaluated, and still sweeps the rest', async () => {
    const sweep = await sweepOtherTranchesL5(
      index({ otherOpenLegacySlugs: [OTHER_DONE, OTHER_OPEN] }),
      async (slug) => {
        if (slug === OTHER_OPEN) throw new Error('gh: HTTP 502\nmore')
        return [ghIssue(slug, 1, 'CLOSED')]
      }
    )
    expect(sweep.unevaluated).toEqual([{ slug: OTHER_OPEN, detail: 'gh: HTTP 502' }])
    expect(sweep.result.failures.map((f) => f.tranche)).toEqual([OTHER_DONE])
  })

  it('reads nothing when the index names no other open legacy tranche', async () => {
    let reads = 0
    const sweep = await sweepOtherTranchesL5(index({ active: [SLUG, LABEL_ONLY] }), async () => {
      reads++
      return []
    })
    expect(reads).toBe(0)
    expect(sweep.result.status).toBe('pass')
  })

  it('does not flag a swept tranche with no task Issues', async () => {
    const sweep = await sweepOtherTranchesL5(index({ otherOpenLegacySlugs: [OTHER_DONE] }), async () => [])
    expect(sweep.result.failures).toEqual([])
  })
})
