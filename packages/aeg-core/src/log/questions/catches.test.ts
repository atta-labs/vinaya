import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset } from '../sync'
import { catchesAndEscapes } from './catches'
import type { HumanLabel } from './labels'

/**
 * Question 5 over the fixture executions. Every expected value below is
 * written by hand from the scenario each execution tells
 * (`../fixtures/executions.ts`) — never produced by the query under test.
 *
 * Check failures: `gate-two-commits` fails once (`test`, then passes at a
 * second commit); `gate-no-commit` fails once (`lint`, after passing with no
 * commit recorded); `gate-same-commit-twice`'s two `build` checks both pass;
 * every `typecheck` check inside a review round passes. Total: 2.
 *
 * Findings resolved: `three-rounds-recurring-finding`'s round 2 comparison
 * resolves nothing (0) and round 3 resolves both `fnd-auth-1` and
 * `fnd-docs-2` (2); `paused-and-resumed`'s round 2 comparison resolves
 * `fnd-q-1` (1). `green-one-round` and `escalated-handoff` run no comparison
 * at all. Total: 3.
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

describe('question 5 — does the product catch anything', () => {
  it('counts a check failure and a resolved finding as a catch, with no labels unknown as escapes', () => {
    const answer = catchesAndEscapes(allFixtures())
    expect(answer.checkFailures).toBe(2)
    expect(answer.findingsResolved).toBe(3)
    expect(answer.catches).toBe(5)
    expect(answer.escapes).toEqual({ known: false, reason: 'no labels recorded' })
  })

  it('states its coverage: every gate and loop row read, one unknown figure named', () => {
    const answer = catchesAndEscapes(allFixtures())
    expect(answer.coverage).toEqual({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // gate 1 + 3 + 2 + 2 + 2 + 2, dev_review_loop 7 + 17 + 14 + 5.
      rowsUsed: 55,
      gaps: 0,
      quarantined: 2,
      unknowns: [{ figure: 'escapes', reason: 'no labels recorded' }]
    })
  })
})

describe('question 5 — labels are the only road to an escape', () => {
  it('reads escapes as a stated zero when labels were supplied but none names a reversal or incident', () => {
    const labels: HumanLabel[] = [{ kind: 'false_rejection', unit: '105', provenance: 'principal ruling on #105' }]
    const answer = catchesAndEscapes(allFixtures(), labels)
    expect(answer.escapes).toEqual({ known: true, value: 0 })
    expect(answer.coverage.unknowns).toEqual([])
  })

  it('counts a reversal and an incident label as escapes, and ignores a false-rejection label', () => {
    const labels: HumanLabel[] = [
      { kind: 'reversal', unit: '102', provenance: 'principal ruling on #102' },
      { kind: 'incident', unit: '103', provenance: 'incident report INC-9' },
      { kind: 'false_rejection', unit: '105', provenance: 'principal ruling on #105' }
    ]
    const answer = catchesAndEscapes(allFixtures(), labels)
    expect(answer.escapes).toEqual({ known: true, value: 2 })
  })
})

describe('question 5 — what it refuses to guess', () => {
  it('leaves low-trust rows out of every figure and counts them', () => {
    const lowTrust = rawLines('gate-two-commits').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.vinaya = '0.30.1'
      return JSON.stringify(object)
    })
    const answer = catchesAndEscapes(datasetOf([...lowTrust, ...rawLines('gate-no-commit')]))
    expect(answer.checkFailures).toBe(1)
    expect(answer.coverage).toMatchObject({ lowTrustLeftOut: 2, rowsRead: 4 })
  })

  it('counts rows with no unit out loud and builds no figure from them', () => {
    const noUnit = rawLines('gate-two-commits').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.work.ref = null
      return JSON.stringify(object)
    })
    const answer = catchesAndEscapes(datasetOf(noUnit))
    expect(answer.checkFailures).toBe(0)
    expect(answer.coverage).toMatchObject({ rowsRead: 2, unitUnknown: 2, rowsUsed: 0 })
  })
})
