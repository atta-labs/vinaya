import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset, Measured } from '../sync'
import { timeByUnit } from './time'
import type { Span } from './time'
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

const span = (summedMs: number, elapsedMs: number, intervals: number, incomplete = 0): Measured<Span> => ({
  known: true,
  value: { summedMs, elapsedMs, intervals, incomplete }
})
const unknownSpan = (reason: string): Measured<Span> => ({ known: false, reason })

describe('question 4 — where the time goes', () => {
  const answer = timeByUnit(allFixtures())
  const noDispatch = (what: string) => unknownSpan(`no ${what} dispatch recorded for this unit`)
  const noCheck = unknownSpan('no check run recorded a duration for this unit')
  const noPause = unknownSpan('no pause recorded for this unit')

  it('reports each dispatch from its dispatched line to its outcome, by the role it ran', () => {
    // Intervals read off the lines: unit 101 — developer 46 667 ms, reviewer 5 709 ms.
    // Unit 102 — developer 6 461 + 29 107 + 38 875, reviewer 58 349 + 29 073 + 34 425.
    // Unit 103 — developer 53 546 + 10 684, reviewer 42 853 + 30 703, one pause of 54 110 ms.
    // Unit 104 — one developer dispatch of 1 442 ms and no reviewer.
    expect(answer.units.slice(0, 4)).toEqual([
      { unit: '101', develop: span(46_667, 46_667, 1), review: span(5_709, 5_709, 1), check: noCheck, wait: noPause },
      {
        unit: '102',
        develop: span(74_443, 74_443, 3),
        review: span(121_847, 121_847, 3),
        check: noCheck,
        wait: noPause
      },
      {
        unit: '103',
        develop: span(64_230, 64_230, 2),
        review: span(73_556, 73_556, 2),
        check: noCheck,
        wait: span(54_110, 54_110, 1)
      },
      { unit: '104', develop: span(1_442, 1_442, 1), review: noDispatch('reviewer'), check: noCheck, wait: noPause }
    ])
  })

  it('reports a unit that only ran checks with every figure unknown, never zero', () => {
    for (const unit of answer.units.slice(4)) {
      expect(unit).toEqual({
        unit: unit.unit,
        develop: noDispatch('developer'),
        review: noDispatch('reviewer'),
        check: noCheck,
        wait: noPause
      })
    }
    // Units 105, 106 and 107 are the three check-only executions; units 108 and 109 carry none of the kinds this question reads.
    expect(answer.units.map((u) => u.unit)).toEqual(['101', '102', '103', '104', '105', '106', '107'])
  })

  it('names every unknown figure, in unit then category order, and counts the rows it read', () => {
    expect(answer.coverage).toMatchObject({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // dispatch 26, gate 1 + 3 + 2 + 2 + 2 + 2, dev_review_loop 43.
      rowsUsed: 81,
      gaps: 0,
      quarantined: 2
    })
    expect(answer.coverage.unknowns.map((u) => u.figure)).toEqual([
      'unit 101.check',
      'unit 101.wait',
      'unit 102.check',
      'unit 102.wait',
      'unit 103.check',
      'unit 104.review',
      'unit 104.check',
      'unit 104.wait',
      ...['105', '106', '107'].flatMap((u) => ['develop', 'review', 'check', 'wait'].map((c) => `unit ${u}.${c}`))
    ])
  })
})

/** A dispatch pair for one role, from `startAt` to `endAt`, built from a fixture's own lines so it stays schema-valid. */
function dispatchPair(effectId: string, role: string, startAt: string, endAt: string): string[] {
  const [dispatched, outcome] = rawLines('green-one-round').filter((raw) => JSON.parse(raw).kind === 'dispatch')
  return [
    [dispatched, startAt, `${effectId}-start`],
    [outcome, endAt, `${effectId}-end`]
  ].map(([raw, at, id]) => {
    const object = JSON.parse(raw as string)
    object.meta.ts = at
    object.meta.event_id = id
    object.effect_id = effectId
    object.target_role = role
    return JSON.stringify(object)
  })
}

/** A check run's summary line ending at `endAt` and lasting `durationMs`. */
function summary(id: string, endAt: string, durationMs: number | null): string {
  const object = JSON.parse(rawLines('gate-no-commit')[0] as string)
  for (const key of ['check', 'check_version', 'policy_version', 'input_fingerprint', 'outcome']) delete object[key]
  Object.assign(object, { event: 'summary', ran: 1, passed: 0, failed: 1, skipped: 0, failed_checks: ['lint'] })
  if (durationMs !== null) object.duration_ms = durationMs
  object.meta.ts = endAt
  object.meta.event_id = id
  return JSON.stringify(object)
}

const at = (seconds: number) => `2026-09-01T10:00:${String(seconds).padStart(2, '0')}.000Z`

describe('question 4 — elapsed time kept apart from summed time', () => {
  it('counts overlapping developer dispatches once in the elapsed time and once per interval in the sum', () => {
    // 0–10 s and 5–20 s overlap: summed 10 + 15 s. A third, 30–35 s, stands apart. On the clock: 0–20 and 30–35 = 25 s.
    const lines = [
      ...dispatchPair('a', 'developer', at(0), at(10)),
      ...dispatchPair('b', 'developer', at(5), at(20)),
      ...dispatchPair('c', 'developer', at(30), at(35))
    ]
    const [unit] = timeByUnit(datasetOf(lines)).units
    expect(unit?.develop).toEqual(span(30_000, 25_000, 3))
    expect(unit?.review).toEqual(unknownSpan('no reviewer dispatch recorded for this unit'))
  })

  it('counts a security dispatch as review and ignores a dispatch of any other role', () => {
    const lines = [...dispatchPair('s', 'security', at(0), at(4)), ...dispatchPair('p', 'planner', at(1), at(9))]
    const [unit] = timeByUnit(datasetOf(lines)).units
    expect(unit?.review).toEqual(span(4_000, 4_000, 1))
    expect(unit?.develop).toEqual(unknownSpan('no developer dispatch recorded for this unit'))
  })

  it("measures a check run backwards from its summary line by the run's own duration", () => {
    // 20–30 s and 25–35 s: summed 20 s, on the clock 15 s.
    const lines = [summary('s1', at(30), 10_000), summary('s2', at(35), 10_000)]
    const [unit] = timeByUnit(datasetOf(lines)).units
    expect(unit?.check).toEqual(span(20_000, 15_000, 2))
  })

  it('keeps a stated zero duration as a number', () => {
    const [unit] = timeByUnit(datasetOf([summary('z', at(30), 0)])).units
    expect(unit?.check).toEqual(span(0, 0, 1))
  })
})

describe('question 4 — what it refuses to guess', () => {
  it('reports a dispatch that never ended as unknown', () => {
    const lines = rawLines('green-one-round').filter((raw) => {
      const object = JSON.parse(raw)
      return !(
        object.kind === 'dispatch' &&
        object.target_role === 'code-reviewer' &&
        object.event === 'outcome_received'
      )
    })
    const [unit] = timeByUnit(datasetOf(lines)).units
    expect(unit?.develop).toEqual(span(46_667, 46_667, 1))
    expect(unit?.review).toEqual(unknownSpan('1 reviewer dispatch has no outcome line'))
  })

  it('reports a pause that was never resumed as unknown', () => {
    const lines = rawLines('paused-and-resumed').filter((raw) => JSON.parse(raw).event !== 'resumed')
    const [unit] = timeByUnit(datasetOf(lines)).units
    expect(unit?.wait).toEqual(unknownSpan('1 pause was never resumed or cancelled'))
  })

  it('reports a check run that recorded no duration as unknown, and counts it beside the ones that did', () => {
    const [none] = timeByUnit(datasetOf([summary('n', at(30), null)])).units
    expect(none?.check).toEqual(unknownSpan('1 check run records no duration'))
    const [some] = timeByUnit(datasetOf([summary('n', at(30), null), summary('d', at(31), 5_000)])).units
    expect(some?.check).toEqual(span(5_000, 5_000, 1, 1))
  })

  it('leaves low-trust rows out of every figure and counts them', () => {
    const lowTrust = rawLines('green-one-round').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.vinaya = '0.30.1'
      return JSON.stringify(object)
    })
    const answer = timeByUnit(datasetOf([...lowTrust, ...rawLines('escalated-handoff')]))
    expect(answer.units.map((u) => u.unit)).toEqual(['104'])
    expect(answer.coverage).toMatchObject({ lowTrustLeftOut: 12, rowsRead: 20 })
  })

  it('counts rows with no unit out loud and builds no unit from them', () => {
    const noUnit = rawLines('green-one-round').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.work.ref = null
      return JSON.stringify(object)
    })
    const answer = timeByUnit(datasetOf(noUnit))
    expect(answer.units).toEqual([])
    expect(answer.coverage).toMatchObject({ rowsRead: 12, unitUnknown: 12, rowsUsed: 0 })
  })
})
