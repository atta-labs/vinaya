import { describe, expect, it } from 'bun:test'
import type { ArchiveDeps } from '../src/commands/archive.js'
import { runArchive, runArchiveTranche, trancheArchivalStatus } from '../src/commands/archive.js'

function archiveDeps(overrides: Partial<ArchiveDeps> = {}): ArchiveDeps {
  return {
    detectRepo: async () => ({ repoRoot: '/tmp/does-not-matter', owner: 'acme', repo: 'widget' }),
    ...overrides
  }
}

describe('vinaya archive — pre-flight', () => {
  it('refuses when not a git repository', async () => {
    const exit = await runArchive([], archiveDeps({ detectRepo: async () => null }))
    expect(exit).toBe(1)
  })

  it('refuses when no GitHub owner/repo can be resolved from `origin`', async () => {
    const exit = await runArchive(
      [],
      archiveDeps({ detectRepo: async () => ({ repoRoot: '/tmp/does-not-matter', owner: '', repo: '' }) })
    )
    expect(exit).toBe(1)
  })
})

describe('vinaya archive tranche — pre-flight', () => {
  it('refuses with no slug argument', async () => {
    const exit = await runArchiveTranche([], archiveDeps())
    expect(exit).toBe(2)
  })

  it('refuses when not a git repository', async () => {
    const exit = await runArchiveTranche(['some-tranche'], archiveDeps({ detectRepo: async () => null }))
    expect(exit).toBe(1)
  })

  it('refuses when no GitHub owner/repo can be resolved from `origin`', async () => {
    const exit = await runArchiveTranche(
      ['some-tranche'],
      archiveDeps({ detectRepo: async () => ({ repoRoot: '/tmp/does-not-matter', owner: '', repo: '' }) })
    )
    expect(exit).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// vinaya-milestone-model-v1 task 1 — `trancheArchivalStatus` is the pure
// derivation `runArchiveTranche` now runs on: "is this tranche done" from its
// OWN `vinaya/tranche:<slug>`-labeled Issues, never from a Milestone's
// `?milestone=<number>` Issue listing (which would have returned every
// sibling tranche's Issues too, once one Milestone can hold several).
// ---------------------------------------------------------------------------

function issueRef(
  state: 'OPEN' | 'CLOSED',
  number = 1,
  title = 'a task'
): { number: number; title: string; state: 'OPEN' | 'CLOSED' } {
  return { number, title, state }
}

describe('trancheArchivalStatus', () => {
  it('no-tranche — zero Issues carry the label', () => {
    expect(trancheArchivalStatus([])).toEqual({ kind: 'no-tranche' })
  })

  it('open — at least one Issue is still open, and every open one is named', () => {
    const open1 = issueRef('OPEN', 10, 'first open task')
    const open2 = issueRef('OPEN', 11, 'second open task')
    const closed = issueRef('CLOSED', 12, 'a closed task')

    expect(trancheArchivalStatus([closed, open1, open2])).toEqual({
      kind: 'open',
      openIssues: [open1, open2]
    })
  })

  it('complete — every Issue is closed', () => {
    expect(trancheArchivalStatus([issueRef('CLOSED'), issueRef('CLOSED', 2)])).toEqual({ kind: 'complete' })
  })

  it('never reads a sibling tranche — only the Issues it is handed, regardless of any shared Milestone', () => {
    // The whole point of moving off `?milestone=<number>`: this function has
    // no Milestone concept at all, so it structurally cannot see another
    // tranche's Issues the way the old query did.
    const onlyThisTranchesIssues = [issueRef('CLOSED', 1), issueRef('CLOSED', 2)]
    expect(trancheArchivalStatus(onlyThisTranchesIssues)).toEqual({ kind: 'complete' })
  })
})
