import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset } from '../sync'
import { completionByModel } from './completion'

/**
 * Question 1 over the fixture executions. Every expected value below is
 * written by hand from `FACT_SHEETS` (`../fixtures/fact-sheets.ts`) and from
 * the scenario each execution tells — never produced by the query under test.
 * The times to green are read off the loop's own journal line of each
 * execution.
 */

function datasetOf(lines: readonly string[]): Dataset {
  const cache = createMemoryCache()
  for (const [position, raw] of lines.entries()) {
    cache.put(normalizeStoredLine(raw, { source: 'fixtures', position: String(position) }))
  }
  return cache.dataset()
}

function allFixtures(): Dataset {
  return datasetOf(buildExecutions().flatMap((execution) => execution.lines.map((line) => line.raw)))
}

/** The same lines with every line written by a CLI older than the low-trust threshold. */
function lowTrust(name: ExecutionName): string[] {
  return buildExecution(name).lines.map((line) => {
    const object = JSON.parse(line.raw)
    object.meta.vinaya = '0.30.1'
    return JSON.stringify(object)
  })
}

describe('question 1 — completion, rounds and time to green by model', () => {
  const answer = completionByModel(allFixtures())

  it('counts the units each model started and how they ended', () => {
    expect(answer.models.map((m) => [m.model, m.started, m.green, m.paused, m.escalated])).toEqual([
      // opus reviewed units 101, 102 and 103; all three went green, 103 after a pause.
      ['opus', 3, 3, 1, 0],
      // sonnet developed 101, 102, 103 (green), 104 (escalated) and, as a role attempt, 108 (no loop).
      ['sonnet', 5, 3, 1, 1]
    ])
  })

  it('gives the distribution of rounds to green, from the rounds each execution ran', () => {
    const rounds = [
      { rounds: 1, units: 1 },
      { rounds: 2, units: 1 },
      { rounds: 3, units: 1 }
    ]
    expect(answer.models.map((m) => m.roundsToGreen)).toEqual([rounds, rounds])
  })

  it('lists the time to green of each green unit, ascending, and never for a unit that did not go green', () => {
    const samples = { known: true, value: [388_644, 768_756, 838_383] }
    expect(answer.models.map((m) => m.timeToGreenMs)).toEqual([samples, samples])
  })

  it('states its coverage: every row read, the low-trust ones left out, and no figure unknown', () => {
    expect(answer.coverage).toEqual({
      // 12 + 32 + 24 + 8 + 2 + 2 + 2 + 7 lines of the first eight executions, and 4 rows of the ninth (a repeat adds none, two lines are quarantined).
      rowsRead: 93,
      // The schema 1, schema 2 and 0.30.1 lines of the ninth execution.
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // dev_review_loop 7 + 17 + 14 + 5, dispatch 4 + 12 + 8 + 2, role_attempt 2.
      rowsUsed: 71,
      gaps: 0,
      quarantined: 2,
      unknowns: []
    })
  })
})

describe('question 1 — what it refuses to guess', () => {
  it('leaves low-trust rows out of every figure and counts them', () => {
    const dataset = datasetOf([
      ...lowTrust('green-one-round'),
      ...buildExecution('escalated-handoff').lines.map((l) => l.raw)
    ])
    const answer = completionByModel(dataset)
    expect(answer.models.map((m) => [m.model, m.started, m.green, m.escalated])).toEqual([['sonnet', 1, 0, 1]])
    expect(answer.coverage.lowTrustLeftOut).toBe(12)
    expect(answer.coverage.rowsRead).toBe(20)
    // dev_review_loop 5 + dispatch 2; the handoff line is not read.
    expect(answer.coverage.rowsUsed).toBe(7)
  })

  it('reports an unknown time to green, with the reason, for a model none of whose units went green', () => {
    const answer = completionByModel(datasetOf(buildExecution('escalated-handoff').lines.map((l) => l.raw)))
    expect(answer.models).toEqual([
      {
        model: 'sonnet',
        started: 1,
        green: 0,
        paused: 0,
        escalated: 1,
        roundsToGreen: [],
        timeToGreenMs: { known: false, reason: 'no unit of work finished green' }
      }
    ])
    expect(answer.coverage.unknowns).toEqual([
      { figure: 'sonnet.timeToGreenMs', reason: 'no unit of work finished green' }
    ])
  })

  it('reports a unit that names no model as unknown rather than attributing it to one', () => {
    const lines = buildExecution('gate-two-commits').lines.map((l) => l.raw)
    const loopOnly = buildExecution('green-one-round')
      .lines.map((l) => l.raw)
      .filter((raw) => JSON.parse(raw).kind === 'dev_review_loop')
    const answer = completionByModel(datasetOf([...lines, ...loopOnly]))
    expect(answer.models).toEqual([])
    expect(answer.coverage.unknowns).toEqual([
      { figure: 'unit 101', reason: 'no dispatch or role attempt of this unit names a model' }
    ])
  })
})
