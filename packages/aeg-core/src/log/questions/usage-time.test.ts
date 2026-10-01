import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset, Measured } from '../sync'
import { usageByUnitAndRole } from './usage'

/**
 * Questions 3 and 4 over the fixture executions. Every expected value below
 * is written by hand from `FACT_SHEETS` (`../fixtures/fact-sheets.ts`) and
 * from the scenario each execution tells — the usage figures and the instants
 * read off the lines themselves — never produced by the query under test.
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

const value = (n: number): Measured<number> => ({ known: true, value: n })
const unknown = (reason: string): Measured<number> => ({ known: false, reason })

describe('question 3 — usage by unit of work and by role', () => {
  const answer = usageByUnitAndRole(allFixtures())

  it('adds each dispatch of a unit by the role it ran, and leaves a cache count no record states unknown', () => {
    const noCache = (n: number) => unknown(`${n} of ${n} observations record no cache`)
    expect(answer.units.slice(0, 4)).toEqual([
      {
        unit: '101',
        observations: 2,
        input: value(3284 + 6759),
        output: value(1385 + 1302),
        cache: noCache(2),
        roles: [
          { role: 'code-reviewer', observations: 1, input: value(6759), output: value(1302), cache: noCache(1) },
          { role: 'developer', observations: 1, input: value(3284), output: value(1385), cache: noCache(1) }
        ]
      },
      {
        unit: '102',
        observations: 6,
        input: value(4887 + 5579 + 3399 + 8675 + 3246 + 5590),
        output: value(325 + 362 + 334 + 696 + 1482 + 542),
        cache: noCache(6),
        roles: [
          {
            role: 'code-reviewer',
            observations: 3,
            input: value(8675 + 3246 + 5590),
            output: value(696 + 1482 + 542),
            cache: noCache(3)
          },
          {
            role: 'developer',
            observations: 3,
            input: value(4887 + 5579 + 3399),
            output: value(325 + 362 + 334),
            cache: noCache(3)
          }
        ]
      },
      {
        unit: '103',
        observations: 4,
        input: value(3614 + 8722 + 4775 + 2318),
        output: value(301 + 1416 + 419 + 764),
        cache: noCache(4),
        roles: [
          {
            role: 'code-reviewer',
            observations: 2,
            input: value(4775 + 2318),
            output: value(419 + 764),
            cache: noCache(2)
          },
          {
            role: 'developer',
            observations: 2,
            input: value(3614 + 8722),
            output: value(301 + 1416),
            cache: noCache(2)
          }
        ]
      },
      {
        unit: '104',
        observations: 1,
        input: value(6852),
        output: value(1076),
        cache: noCache(1),
        roles: [{ role: 'developer', observations: 1, input: value(6852), output: value(1076), cache: noCache(1) }]
      }
    ])
  })

  it('reports a unit whose observations state no usage as unknown, retries included', () => {
    // Unit 108: opus cumulative twice (one term), sonnet delta three times (three terms, the last stating nothing),
    // and two role attempts, one failed and one completed, each with usage null.
    expect(answer.units[4]).toEqual({
      unit: '108',
      observations: 6,
      input: unknown('3 of 6 observations record no input'),
      output: unknown('3 of 6 observations record no output'),
      cache: unknown('4 of 6 observations record no cache'),
      roles: [
        {
          role: 'developer',
          observations: 2,
          input: unknown('2 of 2 observations record no input'),
          output: unknown('2 of 2 observations record no output'),
          cache: unknown('2 of 2 observations record no cache')
        },
        {
          role: 'unattributed',
          observations: 4,
          input: unknown('1 of 4 observations record no input'),
          output: unknown('1 of 4 observations record no output'),
          cache: unknown('2 of 4 observations record no cache')
        }
      ]
    })
    expect(answer.units.map((u) => u.unit)).toEqual(['101', '102', '103', '104', '108'])
  })

  it('adds the same role across units, unknown wherever any unit is unknown', () => {
    expect(answer.roles).toEqual([
      {
        role: 'code-reviewer',
        observations: 6,
        input: value(6759 + 8675 + 3246 + 5590 + 4775 + 2318),
        output: value(1302 + 696 + 1482 + 542 + 419 + 764),
        cache: unknown('6 of 6 observations record no cache')
      },
      {
        role: 'developer',
        observations: 9,
        input: unknown('2 of 9 observations record no input'),
        output: unknown('2 of 9 observations record no output'),
        cache: unknown('9 of 9 observations record no cache')
      },
      {
        role: 'unattributed',
        observations: 4,
        input: unknown('1 of 4 observations record no input'),
        output: unknown('1 of 4 observations record no output'),
        cache: unknown('2 of 4 observations record no cache')
      }
    ])
  })

  it('names every unknown figure with its reason, and counts the rows it read', () => {
    expect(answer.coverage).toMatchObject({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // usage 5, role_attempt 2, dispatch 4 + 12 + 8 + 2.
      rowsUsed: 33,
      gaps: 0,
      quarantined: 2
    })
    const figures = answer.coverage.unknowns.map((u) => u.figure)
    expect(figures).toContain('unit 108.input')
    expect(figures).toContain('unit 108 developer.cache')
    expect(figures).toContain('role developer.input')
    expect(figures).toContain('unit 101.cache')
    expect(figures).not.toContain('unit 101.input')
    for (const u of answer.coverage.unknowns) expect(u.reason).not.toBe('')
    // Every unknown total in the answer — unit, unit and role, and role — is listed exactly once.
    const unknownTotals = [...answer.units, ...answer.units.flatMap((u) => u.roles), ...answer.roles].flatMap((t) =>
      [t.input, t.output, t.cache].filter((m) => !m.known)
    )
    expect(answer.coverage.unknowns).toHaveLength(unknownTotals.length)
  })
})

describe('question 3 — cumulative totals are levels, deltas are additions', () => {
  // The first two lines of unit 108 are cumulative opus observations (1000 then 2500 input); the next two are sonnet deltas.
  const lines = rawLines('usage-and-models')

  it('takes the last cumulative observation of a run and model, never the sum of them', () => {
    const answer = usageByUnitAndRole(datasetOf(lines.slice(0, 2)))
    expect(answer.units).toEqual([
      {
        unit: '108',
        observations: 1,
        input: value(2500),
        output: value(600),
        cache: value(1200),
        roles: [{ role: 'unattributed', observations: 1, input: value(2500), output: value(600), cache: value(1200) }]
      }
    ])
  })

  it('adds delta observations, and keeps a stated zero as a number', () => {
    const first = usageByUnitAndRole(datasetOf(lines.slice(2, 3)))
    expect(first.units[0]).toMatchObject({ input: value(300), output: value(80), cache: value(0) })
    const both = usageByUnitAndRole(datasetOf(lines.slice(2, 4)))
    expect(both.units[0]).toMatchObject({
      input: value(450),
      output: value(120),
      cache: unknown('1 of 2 observations record no cache')
    })
  })

  it('does not add a cumulative level to the deltas of another model', () => {
    const answer = usageByUnitAndRole(datasetOf(lines.slice(0, 4)))
    expect(answer.units[0]).toMatchObject({
      observations: 3,
      input: value(2500 + 300 + 150),
      output: value(600 + 80 + 40)
    })
  })
})

describe('question 3 — what it refuses to guess', () => {
  it('counts rows with no unit out loud and builds no unit from them', () => {
    const noUnit = rawLines('usage-and-models').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.work.ref = null
      return JSON.stringify(object)
    })
    const answer = usageByUnitAndRole(datasetOf(noUnit))
    expect(answer.units).toEqual([])
    expect(answer.roles).toEqual([])
    expect(answer.coverage).toMatchObject({ rowsRead: 7, unitUnknown: 7, rowsUsed: 0 })
  })

  it('leaves low-trust rows out of every figure and counts them', () => {
    const lowTrust = rawLines('green-one-round').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.vinaya = '0.30.1'
      return JSON.stringify(object)
    })
    const answer = usageByUnitAndRole(datasetOf([...lowTrust, ...rawLines('escalated-handoff')]))
    expect(answer.units.map((u) => u.unit)).toEqual(['104'])
    expect(answer.coverage).toMatchObject({ lowTrustLeftOut: 12, rowsRead: 20 })
  })

  it('counts one attempt once when a dispatch and a role attempt share an effect id', () => {
    const [dispatched, outcome] = rawLines('green-one-round')
      .filter((raw) => JSON.parse(raw).kind === 'dispatch')
      .slice(0, 2)
    const effectId = JSON.parse(outcome as string).effect_id
    const attempt = JSON.parse(rawLines('usage-and-models')[6] as string)
    attempt.meta.work.ref = '101'
    attempt.effect_id = effectId
    attempt.role = 'developer'
    attempt.usage = { input: 3284, output: 1385 }
    attempt.meta.event_id = 'evt-shared-effect'
    const answer = usageByUnitAndRole(datasetOf([dispatched as string, outcome as string, JSON.stringify(attempt)]))
    expect(answer.units[0]).toMatchObject({ observations: 1, input: value(3284), output: value(1385) })
  })
})
