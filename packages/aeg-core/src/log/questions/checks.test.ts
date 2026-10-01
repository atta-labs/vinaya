import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset, Measured } from '../sync'
import { checkOutcomes } from './checks'
import type { HumanLabel } from './labels'

/**
 * Question 6 over the fixture executions. Every expected value below is
 * written by hand from the scenario each execution tells
 * (`../fixtures/executions.ts`) and the instants read off its lines directly
 * — never produced by the query under test. None of the fixture executions
 * logs a `gate` `summary` line, so `ran`/`passed`/`skipped` are hand-built
 * below from locally constructed lines, the same way `usage-time.test.ts`
 * builds a `summary` line for question 4.
 *
 * `typecheck` runs clean in every review round (6 checked lines, all pass):
 * 0 failures. `test` (`gate-two-commits`) fails once then passes at a second
 * commit on the same fingerprint: 1 failure, corrected. `lint`
 * (`gate-no-commit`) passes then fails, with no later pass: 1 failure,
 * uncorrected. `build` (`gate-same-commit-twice`) passes twice: 0 failures.
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

const known = (n: number[]): Measured<number[]> => ({ known: true, value: n })
const unknown = (reason: string): Measured<number[]> => ({ known: false, reason })

/** The two `gate-two-commits` lines' instants, read off the lines (`test` fails, then passes 4 747 ms later). */
function testCorrectionMs(): number {
  const [fail, pass] = rawLines('gate-two-commits').map((raw) => JSON.parse(raw))
  return Date.parse((pass as { meta: { ts: string } }).meta.ts) - Date.parse((fail as { meta: { ts: string } }).meta.ts)
}

describe('question 6 — which check catches most', () => {
  const answer = checkOutcomes(allFixtures())

  it('counts each check by name, ascending, with its failures and correction time', () => {
    expect(answer.checks).toEqual([
      { check: 'build', failures: 0, correctionTimesMs: unknown('no failure of build was recorded') },
      {
        check: 'lint',
        failures: 1,
        correctionTimesMs: unknown('no failure of lint was followed by a pass of the same unit')
      },
      { check: 'test', failures: 1, correctionTimesMs: known([testCorrectionMs()]) },
      { check: 'typecheck', failures: 0, correctionTimesMs: unknown('no failure of typecheck was recorded') }
    ])
  })

  it('reads ran, passed and skipped as a stated zero: no fixture logs a gate summary line', () => {
    expect(answer.ran).toBe(0)
    expect(answer.passed).toBe(0)
    expect(answer.skipped).toBe(0)
  })

  it('reads false rejections as unknown with no labels supplied', () => {
    expect(answer.falseRejections).toEqual({ known: false, reason: 'no labels recorded' })
  })

  it('states its coverage: every gate row read, every unknown figure named', () => {
    expect(answer.coverage).toEqual({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // typecheck 1 + 3 + 2, test 2, lint 2, build 2.
      rowsUsed: 12,
      gaps: 0,
      quarantined: 2,
      unknowns: [
        { figure: 'build.correctionTimesMs', reason: 'no failure of build was recorded' },
        { figure: 'lint.correctionTimesMs', reason: 'no failure of lint was followed by a pass of the same unit' },
        { figure: 'typecheck.correctionTimesMs', reason: 'no failure of typecheck was recorded' },
        { figure: 'falseRejections', reason: 'no labels recorded' }
      ]
    })
  })
})

describe('question 6 — a check run summary states the totals a checked line cannot', () => {
  /** A check run's summary line, built from a fixture's own gate line so it stays schema-valid. */
  function summary(ran: number, passed: number, failed: number, skipped: number): string {
    const object = JSON.parse(rawLines('gate-no-commit')[0] as string)
    for (const key of ['check', 'check_version', 'policy_version', 'input_fingerprint', 'outcome']) delete object[key]
    Object.assign(object, { event: 'summary', ran, passed, failed, skipped, failed_checks: [] })
    object.meta.event_id = `evt-summary-${ran}-${passed}-${failed}-${skipped}`
    return JSON.stringify(object)
  }

  it('sums ran, passed and skipped across every summary line', () => {
    const answer = checkOutcomes(datasetOf([summary(5, 4, 1, 2), summary(3, 3, 0, 0)]))
    expect(answer.ran).toBe(8)
    expect(answer.passed).toBe(7)
    expect(answer.skipped).toBe(2)
    expect(answer.checks).toEqual([])
  })
})

describe('question 6 — a false rejection is counted only against a check that actually failed', () => {
  it('counts a label naming a unit this check failed for, and ignores one naming a unit it did not', () => {
    const labels: HumanLabel[] = [
      { kind: 'false_rejection', unit: '105', provenance: 'principal ruling on #105' },
      { kind: 'false_rejection', unit: '107', provenance: 'principal ruling on #107' },
      { kind: 'reversal', unit: '105', provenance: 'not a false rejection label' }
    ]
    const answer = checkOutcomes(allFixtures(), labels)
    expect(answer.falseRejections).toEqual({ known: true, value: 1 })
  })

  it('reads a stated zero when labels were supplied but none names a failed check', () => {
    const labels: HumanLabel[] = [{ kind: 'false_rejection', unit: '107', provenance: 'principal ruling on #107' }]
    const answer = checkOutcomes(allFixtures(), labels)
    expect(answer.falseRejections).toEqual({ known: true, value: 0 })
    expect(answer.coverage.unknowns.map((u) => u.figure)).not.toContain('falseRejections')
  })
})

describe('question 6 — what it refuses to guess', () => {
  it('leaves low-trust rows out of every figure and counts them', () => {
    const lowTrust = rawLines('gate-two-commits').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.vinaya = '0.30.1'
      return JSON.stringify(object)
    })
    const answer = checkOutcomes(datasetOf([...lowTrust, ...rawLines('gate-no-commit')]))
    expect(answer.checks).toEqual([
      {
        check: 'lint',
        failures: 1,
        correctionTimesMs: unknown('no failure of lint was followed by a pass of the same unit')
      }
    ])
    expect(answer.coverage).toMatchObject({ lowTrustLeftOut: 2, rowsRead: 4, rowsUsed: 2 })
  })

  it('counts rows with no unit out loud and builds no check entry from them', () => {
    const noUnit = rawLines('gate-two-commits').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.work.ref = null
      return JSON.stringify(object)
    })
    const answer = checkOutcomes(datasetOf(noUnit))
    expect(answer.checks).toEqual([])
    expect(answer.coverage).toMatchObject({ rowsRead: 2, unitUnknown: 2, rowsUsed: 0 })
  })

  it('never calls one fingerprint at two commits non-deterministic — it only counts failures and corrections', () => {
    const answer = checkOutcomes(datasetOf(rawLines('gate-two-commits')))
    expect(answer.checks).toEqual([{ check: 'test', failures: 1, correctionTimesMs: known([testCorrectionMs()]) }])
  })
})
