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

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) }
})

const { resolveConflictsWith, resolveDependsOn } = await import('./verify-dispatch')

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
    throw new Error(`unmocked execFileSync: ${cmd} ${args?.join(' ')}`)
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
