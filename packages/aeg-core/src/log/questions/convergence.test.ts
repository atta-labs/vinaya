import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset, Measured } from '../sync'
import { outcomesByInstructionVersion, recurringFindings } from './convergence'

/**
 * Questions 8, 9 and 10, and the confidence comparison, over the fixture
 * executions. Every expected value below is written by hand from the
 * scenario each execution tells (`../fixtures/executions.ts`) and its own
 * fact sheet (`../fixtures/fact-sheets.ts`) — never produced by the query
 * under test. `three-rounds-recurring-finding` (unit 102) is the only
 * execution whose comparison ever names a recurring finding (`fnd-auth-1`,
 * round 2) or states a developer confidence (round 2: 70, no extra turn;
 * round 3: 92, after the extra turn); `paused-and-resumed` (unit 103) goes
 * green in round 2 without ever stating one. Every execution's lines carry
 * the same doctrine (`fixture-doctrine`) and no way-of-working version.
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

function knownOf<T>(value: T): Measured<T> {
  return { known: true, value }
}

function unknownOf<T>(reason: string): Measured<T> {
  return { known: false, reason }
}

describe('question 8 — which findings recur', () => {
  it("reads the loop's own comparison, with the severity and treatment that round's verdicts read", () => {
    const answer = recurringFindings(allFixtures())
    expect(answer.findings).toEqual([
      { unit: '102', round: 2, id: 'fnd-auth-1', severity: knownOf('MAJOR'), treatment: knownOf('blocking') }
    ])
  })

  it('states its coverage: every dev_review_loop row read, no figure unknown', () => {
    const answer = recurringFindings(allFixtures())
    expect(answer.coverage).toEqual({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // dev_review_loop rows: green 7 + three-rounds 17 + paused 14 + escalated 5.
      rowsUsed: 43,
      gaps: 0,
      quarantined: 2,
      unknowns: []
    })
  })

  it('never recurs a finding by its id alone — a round with no recurring id reports nothing', () => {
    const answer = recurringFindings(datasetOf(rawLines('paused-and-resumed')))
    expect(answer.findings).toEqual([])
  })

  it("reads a recurring id's severity and treatment as unknown when that round's verdicts_read never named it", () => {
    const comparison = JSON.parse(
      rawLines('three-rounds-recurring-finding').find(
        (raw) => (JSON.parse(raw) as { event: string }).event === 'findings_compared'
      )!
    )
    comparison.round = 99
    comparison.recurring = ['fnd-ghost']
    comparison.open = []
    comparison.resolved = []
    comparison.new = []
    comparison.meta.event_id = 'evt-ghost-comparison'

    const answer = recurringFindings(datasetOf([JSON.stringify(comparison)]))
    const reason = "round 99's verdicts_read of unit 102 names no finding fnd-ghost"
    expect(answer.findings).toEqual([
      { unit: '102', round: 99, id: 'fnd-ghost', severity: unknownOf(reason), treatment: unknownOf(reason) }
    ])
    expect(answer.coverage.unknowns).toEqual([
      { figure: '102.99.fnd-ghost.severity', reason },
      { figure: '102.99.fnd-ghost.treatment', reason }
    ])
  })

  it('leaves low-trust rows out and reports no recurring finding from them', () => {
    const lowTrust = rawLines('three-rounds-recurring-finding').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.vinaya = '0.30.1'
      return JSON.stringify(object)
    })
    const answer = recurringFindings(datasetOf(lowTrust))
    expect(answer.findings).toEqual([])
    expect(answer.coverage).toMatchObject({ lowTrustLeftOut: 32, rowsRead: 32, rowsUsed: 0 })
  })
})

describe('question 9 — is the instruction version the problem', () => {
  it("groups outcomes by the doctrine a unit's own lines name", () => {
    const answer = outcomesByInstructionVersion(allFixtures())
    expect(answer.versions).toEqual([
      {
        version: 'fixture-doctrine',
        flowVersions: [],
        units: 4,
        escalated: 1,
        roundsToGreen: [
          { rounds: 1, units: 1 },
          { rounds: 2, units: 1 },
          { rounds: 3, units: 1 }
        ],
        // green-one-round 0 + three-rounds 2 (rounds 1, 2) + paused 1 (round 1) + escalated-handoff 0 (no verdict) = 3.
        unmetObjectives: knownOf(3)
      }
    ])
  })

  it('states its coverage: every dev_review_loop and dispatch row read, no figure unknown', () => {
    const answer = outcomesByInstructionVersion(allFixtures())
    expect(answer.coverage).toEqual({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // dev_review_loop 43 + dispatch 26.
      rowsUsed: 69,
      gaps: 0,
      quarantined: 2,
      unknowns: []
    })
  })

  it('reads unmet objectives as unknown — never zero — when a version recorded no verdict at all', () => {
    const answer = outcomesByInstructionVersion(datasetOf(rawLines('escalated-handoff')))
    expect(answer.versions).toEqual([
      {
        version: 'fixture-doctrine',
        flowVersions: [],
        units: 1,
        escalated: 1,
        roundsToGreen: [],
        unmetObjectives: unknownOf("no verdict was recorded for version fixture-doctrine's units")
      }
    ])
  })

  it('never compares instruction versions as a cause — each version is counted independently', () => {
    const otherVersion = rawLines('green-one-round').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.doctrine = 'fixture-doctrine-v2'
      return JSON.stringify(object)
    })
    const answer = outcomesByInstructionVersion(datasetOf([...otherVersion, ...rawLines('paused-and-resumed')]))
    expect(answer.versions).toEqual([
      {
        version: 'fixture-doctrine',
        flowVersions: [],
        units: 1,
        escalated: 0,
        roundsToGreen: [{ rounds: 2, units: 1 }],
        unmetObjectives: knownOf(1)
      },
      {
        version: 'fixture-doctrine-v2',
        flowVersions: [],
        units: 1,
        escalated: 0,
        roundsToGreen: [{ rounds: 1, units: 1 }],
        unmetObjectives: knownOf(0)
      }
    ])
  })
})
