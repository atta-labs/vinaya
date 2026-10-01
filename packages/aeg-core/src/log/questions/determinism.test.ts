import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset } from '../sync'
import { determinism } from './determinism'

/**
 * Question 7 over the fixture executions. Every expected value below is
 * written by hand from the scenario each execution tells
 * (`../fixtures/executions.ts`) and the fields read off its lines directly —
 * never produced by the query under test. Only two `gate` `checked` lines in
 * the whole fixture set fail: `test` in `gate-two-commits` (a commit
 * recorded) and `lint` in `gate-no-commit` (no commit on either line).
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

const DETERMINISM_UNKNOWN = {
  known: false,
  reason:
    'a passing check is recorded only in a run summary, so a pass and a fail of the same input cannot be seen together'
}

describe('question 7 — are checks deterministic', () => {
  const answer = determinism(allFixtures())

  it('lists every failing check, ascending by check name, by its version, fingerprint and commit', () => {
    const failingTest = JSON.parse(rawLines('gate-two-commits')[0] as string)
    const failingLint = JSON.parse(rawLines('gate-no-commit')[1] as string)
    expect(answer.failures).toEqual([
      {
        check: 'lint',
        checkVersion: failingLint.check_version,
        inputFingerprint: failingLint.input_fingerprint,
        commit: { known: false, reason: 'no commit recorded for this event' }
      },
      {
        check: 'test',
        checkVersion: failingTest.check_version,
        inputFingerprint: failingTest.input_fingerprint,
        commit: { known: true, value: failingTest.subject.sha }
      }
    ])
  })

  it('always reads determinism itself as unknown, with the reason', () => {
    expect(answer.determinism).toEqual(DETERMINISM_UNKNOWN)
    expect(answer.coverage.unknowns).toContainEqual({ figure: 'determinism', reason: DETERMINISM_UNKNOWN.reason })
  })

  it('states its coverage: every gate row read', () => {
    expect(answer.coverage).toMatchObject({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      rowsUsed: 12,
      gaps: 0,
      quarantined: 2
    })
  })
})

describe('question 7 — what it refuses to guess', () => {
  it('never calls the same fingerprint failing then passing at two commits non-deterministic', () => {
    const answer = determinism(datasetOf(rawLines('gate-two-commits')))
    expect(answer.failures).toHaveLength(1)
    expect(answer.failures[0]?.commit).toMatchObject({ known: true })
    expect(answer.determinism).toEqual(DETERMINISM_UNKNOWN)
  })

  it('reads a failure with no recorded commit as unknown, never as deterministic or not', () => {
    const answer = determinism(datasetOf(rawLines('gate-no-commit')))
    expect(answer.failures).toEqual([
      expect.objectContaining({ check: 'lint', commit: { known: false, reason: 'no commit recorded for this event' } })
    ])
  })

  it('leaves low-trust rows out of every figure and counts them', () => {
    const lowTrust = rawLines('gate-two-commits').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.vinaya = '0.30.1'
      return JSON.stringify(object)
    })
    const answer = determinism(datasetOf([...lowTrust, ...rawLines('gate-no-commit')]))
    expect(answer.failures).toEqual([
      expect.objectContaining({ check: 'lint', commit: { known: false, reason: 'no commit recorded for this event' } })
    ])
    expect(answer.coverage).toMatchObject({ lowTrustLeftOut: 2, rowsRead: 4, rowsUsed: 2 })
  })

  it('counts rows with no unit out loud and builds no failure record from them', () => {
    const noUnit = rawLines('gate-two-commits').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.work.ref = null
      return JSON.stringify(object)
    })
    const answer = determinism(datasetOf(noUnit))
    expect(answer.failures).toEqual([])
    expect(answer.coverage).toMatchObject({ rowsRead: 2, unitUnknown: 2, rowsUsed: 0 })
  })

  it('reports no failures, and determinism still unknown, over a dataset with none', () => {
    const answer = determinism(datasetOf(rawLines('gate-same-commit-twice')))
    expect(answer.failures).toEqual([])
    expect(answer.determinism).toEqual(DETERMINISM_UNKNOWN)
  })
})
