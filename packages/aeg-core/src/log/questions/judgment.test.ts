import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset } from '../sync'
import { reviewerStrictness } from './judgment'

/**
 * Question 2 over the fixture executions. Every expected value below is
 * written by hand from the scenario each execution tells
 * (`../fixtures/executions.ts`) — never produced by the query under test.
 * Every verdict in the fixtures is a `code-reviewer`/`opus` dispatch:
 * `green-one-round` approves with no findings; `three-rounds-recurring-finding`
 * requests changes twice (round 1 carries the MAJOR, blocking `fnd-auth-1`;
 * round 2 carries it again beside the MINOR, non-blocking `fnd-docs-2`) then
 * approves with nothing outstanding; `paused-and-resumed` requests changes
 * once (the MAJOR, blocking `fnd-q-1`) then approves clean.
 */

function datasetOf(lines: readonly string[]): Dataset {
  const cache = createMemoryCache()
  for (const [position, raw] of lines.entries()) {
    cache.put(normalizeStoredLine(raw, { source: 'fixtures', position: String(position) }))
  }
  return cache.dataset()
}

function rawLines(name: ExecutionName): string[] {
  return buildExecution(name).lines.map((line) => line.raw)
}

function allFixtures(): Dataset {
  return datasetOf(buildExecutions().flatMap((execution) => execution.lines.map((line) => line.raw)))
}

describe('question 2 — are reviewers strict', () => {
  const answer = reviewerStrictness(allFixtures())

  it('counts every verdict a code-reviewer/opus dispatch recorded, approved and changes requested', () => {
    expect(answer.reviewers).toEqual([
      {
        role: 'code-reviewer',
        model: 'opus',
        verdictsRead: 6,
        approved: 3,
        changesRequested: 3,
        findings: [
          { verdict: 'approved', bySeverity: [] },
          {
            verdict: 'changes_requested',
            bySeverity: [
              { severity: 'MAJOR', findings: 3, blockers: 3 },
              { severity: 'MINOR', findings: 1, blockers: 0 }
            ]
          }
        ]
      }
    ])
  })

  it('states its coverage: every dispatch row read, no figure unknown', () => {
    expect(answer.coverage).toEqual({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // dispatch 4 (green) + 12 (three-rounds) + 8 (paused) + 2 (escalated-handoff).
      rowsUsed: 26,
      gaps: 0,
      quarantined: 2,
      unknowns: []
    })
  })
})

describe('question 2 — what it refuses to guess', () => {
  it('never reports whether a reviewer was right — only counts', () => {
    const answer = reviewerStrictness(allFixtures())
    for (const key of Object.keys(answer.reviewers[0] as object)) {
      expect(key).not.toMatch(/correct|right|good|strict|lenient/i)
    }
  })

  it('leaves low-trust rows out of every figure and counts them', () => {
    const lowTrust = rawLines('green-one-round').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.vinaya = '0.30.1'
      return JSON.stringify(object)
    })
    const answer = reviewerStrictness(datasetOf([...lowTrust, ...rawLines('escalated-handoff')]))
    expect(answer.reviewers).toEqual([])
    // escalated-handoff's 2 dispatch rows (one developer round) are trusted and read, but neither is a verdict.
    expect(answer.coverage).toMatchObject({ lowTrustLeftOut: 12, rowsRead: 20, rowsUsed: 2 })
  })

  it('counts rows with no unit out loud and builds no reviewer group from them', () => {
    const noUnit = rawLines('green-one-round').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.work.ref = null
      return JSON.stringify(object)
    })
    const answer = reviewerStrictness(datasetOf(noUnit))
    expect(answer.reviewers).toEqual([])
    expect(answer.coverage).toMatchObject({ rowsRead: 12, unitUnknown: 4, rowsUsed: 0 })
  })

  it('reports a single-round unit with no findings as a clean approval', () => {
    const answer = reviewerStrictness(datasetOf(rawLines('green-one-round')))
    expect(answer.reviewers).toEqual([
      {
        role: 'code-reviewer',
        model: 'opus',
        verdictsRead: 1,
        approved: 1,
        changesRequested: 0,
        findings: [
          { verdict: 'approved', bySeverity: [] },
          { verdict: 'changes_requested', bySeverity: [] }
        ]
      }
    ])
  })
})
