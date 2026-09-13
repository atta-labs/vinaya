import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, Tranche } from '../src/types'

/**
 * Regression coverage for #196 — the Issue's failure table, one test per row,
 * plus the two new unresolvable-edge cases the message split (dispatch-gate.ts)
 * needs. `resolveDependsOn`/`resolveConflictsWith` are `verify-dispatch.ts`'s
 * own resolver; a fake `resolveSibling` is injected so the slug-qualified
 * rows never make a real forge call — only `directIssueNumFromEdge`'s `#NNN`
 * path (rows 2/3) shells out to `gh`, which is mocked below.
 */

const execFileSyncMock = vi.fn()
// `fetchBacklogIssuePrsBatch` (issue-586, O2 round 2 self-fix) shells out
// through the ASYNC, larger-buffer `execFile` (`promisify.custom`), not the
// sync `execFileSync` every other call in this suite uses — a real `gh pr
// list --json …,body --limit 300` on this repo is several MB, well past
// `execFileSync`'s 1 MB default, which is exactly the bug this fetcher
// first shipped with (silently returning zero PRs). Stubbed the same way
// `gh.test.ts`/`verify-dispatch.test.ts` stub it.
const execFileAsyncMock = vi.fn()

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = (() => {
    throw new Error('callback form not used by these tests')
  }) as unknown as typeof actual.execFile
  ;(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (...args: unknown[]) =>
    execFileAsyncMock(...args)
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args), execFile }
})

const { fetchBacklogIssuePrsBatch, resolveConflictsWith, resolveDependsOn } = await import('./verify-dispatch')

const REPO = { owner: 'atta-labs', repo: 'vinaya' }

function makeTask(id: string, issue: number | null): Task {
  return { id, title: `Task ${id}`, issue, projects: ['aeg'], dependsOn: [], conflictsWith: [], rationaleMarkdown: '' }
}

function makeTranche(name: string, tasks: Task[]): Tranche {
  return { name, lifecycle: 'active', goal: '', tasks, backlog: [] }
}

beforeEach(() => {
  execFileSyncMock.mockReset()
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view' && args[2] === '192') {
      return JSON.stringify({ number: 192, state: 'CLOSED', labels: [] })
    }
    // `resolveDependsOn`'s own batched fetcher (`fetchIssueStatesBatch`) —
    // one `gh api graphql` call regardless of how many numbers the
    // query aliases; every row below that resolves a direct `#192` edge
    // resolves through this, not a per-edge `gh issue view`.
    if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ data: { repository: { i_192: { state: 'CLOSED' } } } })
    }
    throw new Error(`unmocked execFileSync: ${cmd} ${args?.join(' ')}`)
  })
  execFileAsyncMock.mockReset()
  // `resolveDependsOn`'s OTHER batched fetcher (`fetchBacklogIssuePrsBatch`,
  // issue-586 O2) — every direct-edge row also probes for the Issue's own
  // `task/issue-<n>` pull request. No PR by default, so every row above
  // that never opts into a fixture below falls back to the Issue-state
  // check exactly as before this task.
  execFileAsyncMock.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') return Promise.resolve({ stdout: '[]', stderr: '' })
    throw new Error(`unmocked execFile: ${args?.join(' ')}`)
  })
})

describe('resolveDependsOn — #196 regression table', () => {
  const homeTranche = makeTranche('home-tranche', [makeTask('2', 111)])

  it('row 1: `2` (same-tranche) resolves via the branch-PR map', async () => {
    const branchPrs = new Map([
      ['2', { number: 5, headRefName: 'task/home-tranche/2', state: 'MERGED' as const, mergedAt: '2026-01-01' }]
    ])
    const [fact] = await resolveDependsOn(['2'], homeTranche, branchPrs, REPO)
    expect(fact).toEqual({ id: '2', issue: 111, merged: true })
  })

  it('row 2: `#192` resolves via a direct Issue lookup', async () => {
    const [fact] = await resolveDependsOn(['#192'], homeTranche, new Map(), REPO)
    expect(fact).toEqual({ id: '#192', issue: 192, merged: true })
  })

  it('row 3: `some-tranche #192` resolves — the `#NNN` match fires before the slug branch', async () => {
    const [fact] = await resolveDependsOn(['some-tranche #192'], homeTranche, new Map(), REPO)
    expect(fact).toEqual({ id: 'some-tranche #192', issue: 192, merged: true })
  })

  it('row 4 (the fix): `some-tranche 2` resolves via the sibling tranche, not "unmerged forever"', async () => {
    const resolveSibling = async (slug: string) =>
      slug === 'some-tranche'
        ? {
            tranche: makeTranche('some-tranche', [makeTask('2', 4242)]),
            branchPrs: new Map([
              [
                '2',
                {
                  number: 9,
                  headRefName: 'task/some-tranche/2',
                  state: 'MERGED' as const,
                  mergedAt: '2026-08-24T02:05:55Z'
                }
              ]
            ])
          }
        : null
    const [fact] = await resolveDependsOn(['some-tranche 2'], homeTranche, new Map(), REPO, resolveSibling)
    expect(fact).toEqual({ id: 'some-tranche 2', issue: 4242, merged: true })
  })

  it('unknown-slug case: UNRESOLVABLE, not a false "unmerged"', async () => {
    const resolveSibling = async () => null
    const [fact] = await resolveDependsOn(['ghost-tranche 2'], homeTranche, new Map(), REPO, resolveSibling)
    expect(fact).toEqual({ id: 'ghost-tranche 2', issue: null, merged: false, resolved: false })
  })

  it('unknown-id-in-known-slug case: UNRESOLVABLE, not a false "unmerged"', async () => {
    const resolveSibling = async () => ({
      tranche: makeTranche('some-tranche', [makeTask('3', 4243)]),
      branchPrs: new Map()
    })
    const [fact] = await resolveDependsOn(['some-tranche 99'], homeTranche, new Map(), REPO, resolveSibling)
    expect(fact).toEqual({ id: 'some-tranche 99', issue: null, merged: false, resolved: false })
  })

  it('unchanged behavior: an unmerged same-tranche edge still resolves — merged: false, resolved absent', async () => {
    const branchPrs = new Map([
      ['2', { number: 5, headRefName: 'task/home-tranche/2', state: 'OPEN' as const, mergedAt: null }]
    ])
    const [fact] = await resolveDependsOn(['2'], homeTranche, branchPrs, REPO)
    expect(fact).toEqual({ id: '2', issue: 111, merged: false })
  })
})

describe('resolveDependsOn — O2: a backlog Issue resolves through its own pull request', () => {
  const homeTranche = makeTranche('home-tranche', [])

  it('a merged `task/issue-<n>` pull request makes the dependency dispatchable, regardless of the fetched Issue state', async () => {
    const fetchIssueStates = () => new Map<number, 'OPEN' | 'CLOSED'>([[586, 'CLOSED']])
    const fetchBacklogPrs = vi.fn(
      async (numbers: number[]) =>
        new Map(
          numbers.map((n) => [
            n,
            { number: 900, headRefName: 'task/issue-586', state: 'MERGED' as const, mergedAt: '2026-09-14' }
          ])
        )
    )
    const [fact] = await resolveDependsOn(
      ['#586'],
      homeTranche,
      new Map(),
      REPO,
      async () => null,
      fetchIssueStates,
      fetchBacklogPrs
    )
    expect(fact).toEqual({ id: '#586', issue: 586, merged: true })
    expect(fetchBacklogPrs).toHaveBeenCalledTimes(1)
    expect(fetchBacklogPrs.mock.calls[0]?.[0]).toEqual([586])
  })

  it('an open `task/issue-<n>` pull request refuses the dependency, naming it, even though the Issue itself is not closed', async () => {
    const fetchIssueStates = () => new Map<number, 'OPEN' | 'CLOSED'>([[586, 'OPEN']])
    const fetchBacklogPrs = async () =>
      new Map([[586, { number: 900, headRefName: 'task/issue-586', state: 'OPEN' as const, mergedAt: null }]])
    const [fact] = await resolveDependsOn(
      ['#586'],
      homeTranche,
      new Map(),
      REPO,
      async () => null,
      fetchIssueStates,
      fetchBacklogPrs
    )
    expect(fact).toEqual({ id: '#586', issue: 586, merged: false })
  })

  it('trap: an Issue closed WITHOUT a merge (its PR is open) never reads as merged', async () => {
    const fetchIssueStates = () => new Map<number, 'OPEN' | 'CLOSED'>([[586, 'CLOSED']])
    const fetchBacklogPrs = async () =>
      new Map([[586, { number: 900, headRefName: 'task/issue-586', state: 'OPEN' as const, mergedAt: null }]])
    const [fact] = await resolveDependsOn(
      ['#586'],
      homeTranche,
      new Map(),
      REPO,
      async () => null,
      fetchIssueStates,
      fetchBacklogPrs
    )
    expect(fact).toEqual({ id: '#586', issue: 586, merged: false })
  })

  it('no PR resolves by branch or body: falls back to the Issue closed/open state, unchanged from before this task', async () => {
    const fetchIssueStates = () => new Map<number, 'OPEN' | 'CLOSED'>([[586, 'CLOSED']])
    const fetchBacklogPrs = async () => new Map()
    const [fact] = await resolveDependsOn(
      ['#586'],
      homeTranche,
      new Map(),
      REPO,
      async () => null,
      fetchIssueStates,
      fetchBacklogPrs
    )
    expect(fact).toEqual({ id: '#586', issue: 586, merged: true })
  })
})

describe('fetchBacklogIssuePrsBatch', () => {
  it('matches by the task/issue-<n> branch first', async () => {
    execFileAsyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return Promise.resolve({
          stdout: JSON.stringify([
            { number: 900, headRefName: 'task/issue-586', state: 'MERGED', mergedAt: '2026-09-14', body: '' }
          ]),
          stderr: ''
        })
      }
      throw new Error(`unmocked execFile: ${args?.join(' ')}`)
    })
    const result = await fetchBacklogIssuePrsBatch([586], REPO)
    expect(result.get(586)?.number).toBe(900)
  })

  it('falls back to a `Closes #<n>` body match when no branch matches', async () => {
    execFileAsyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              number: 901,
              headRefName: 'fix/control-store-fast-path',
              state: 'MERGED',
              mergedAt: '2026-09-14',
              body: 'Summary\n\nCloses #586\n'
            }
          ]),
          stderr: ''
        })
      }
      throw new Error(`unmocked execFile: ${args?.join(' ')}`)
    })
    const result = await fetchBacklogIssuePrsBatch([586], REPO)
    expect(result.get(586)?.number).toBe(901)
  })

  it('returns no entry for a number matching neither a branch nor a Closes body', async () => {
    execFileAsyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') return Promise.resolve({ stdout: '[]', stderr: '' })
      throw new Error(`unmocked execFile: ${args?.join(' ')}`)
    })
    expect((await fetchBacklogIssuePrsBatch([586], REPO)).has(586)).toBe(false)
  })

  it("tolerates a `gh pr list --json …,body` payload past execFileSync's 1 MB default — the ENOBUFS shape this fetcher first shipped with", async () => {
    const bigBody = 'x'.repeat(2 * 1024 * 1024)
    execFileAsyncMock.mockImplementation((_bin: string, args: string[], opts: { maxBuffer?: number }) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        expect(opts?.maxBuffer).toBeGreaterThan(2 * 1024 * 1024)
        return Promise.resolve({
          stdout: JSON.stringify([
            { number: 900, headRefName: 'task/issue-586', state: 'MERGED', mergedAt: '2026-09-14', body: bigBody }
          ]),
          stderr: ''
        })
      }
      throw new Error(`unmocked execFile: ${args?.join(' ')}`)
    })
    const result = await fetchBacklogIssuePrsBatch([586], REPO)
    expect(result.get(586)?.number).toBe(900)
  })
})

describe('resolveDependsOn — one batched forge read for the whole edge list', () => {
  const homeTranche = makeTranche('home-tranche', [])

  it('twenty-six direct-issue edges resolve with exactly one fetchIssueStates call, each verdict matching a per-edge lookup', async () => {
    const edgeCount = 26
    const edges = Array.from({ length: edgeCount }, (_, i) => `#${i + 1}`)
    // Odd-numbered Issues closed, even-numbered open — same per-edge verdict
    // an unbatched `gh issue view <n>` per edge would have produced.
    const fetchIssueStates = vi.fn((numbers: number[]) => {
      const m = new Map<number, 'OPEN' | 'CLOSED'>()
      for (const n of numbers) m.set(n, n % 2 === 1 ? 'CLOSED' : 'OPEN')
      return m
    })

    const facts = await resolveDependsOn(edges, homeTranche, new Map(), REPO, async () => null, fetchIssueStates)

    expect(fetchIssueStates).toHaveBeenCalledTimes(1)
    expect(fetchIssueStates.mock.calls[0]?.[0]).toHaveLength(edgeCount)
    expect(facts).toHaveLength(edgeCount)
    for (let i = 0; i < edgeCount; i++) {
      const n = i + 1
      expect(facts[i]).toEqual({ id: `#${n}`, issue: n, merged: n % 2 === 1 })
    }
  })
})

describe('resolveConflictsWith — shares the same slug-form resolution gap, fixed identically', () => {
  const homeTranche = makeTranche('home-tranche', [makeTask('2', 111)])

  it('`some-tranche 2` resolves an open sibling PR as in-flight', async () => {
    const resolveSibling = async () => ({
      tranche: makeTranche('some-tranche', [makeTask('2', 4242)]),
      branchPrs: new Map([
        ['2', { number: 9, headRefName: 'task/some-tranche/2', state: 'OPEN' as const, mergedAt: null }]
      ])
    })
    const [fact] = await resolveConflictsWith(['some-tranche 2'], homeTranche, new Map(), REPO, resolveSibling)
    expect(fact).toEqual({ id: 'some-tranche 2', issue: 4242, openOrInFlight: true })
  })

  it('an unresolvable slug edge stays the existing conservative "not blocking" default', async () => {
    const resolveSibling = async () => null
    const [fact] = await resolveConflictsWith(['ghost-tranche 2'], homeTranche, new Map(), REPO, resolveSibling)
    expect(fact).toEqual({ id: 'ghost-tranche 2', issue: null, openOrInFlight: false })
  })
})
