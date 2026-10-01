import { describe, expect, it } from 'vitest'
import { createMemoryCache } from '../sync'
import { catchesAndEscapes } from './catches'
import { checkOutcomes } from './checks'
import { completionByModel } from './completion'
import { determinism } from './determinism'
import { QUESTIONS } from './index'
import { reviewerStrictness } from './judgment'
import { timeByUnit } from './time'
import { usageByUnitAndRole } from './usage'

describe('QUESTIONS', () => {
  it('holds one entry per question under its number: q1 through q7, skipping none registered yet', () => {
    expect(Object.keys(QUESTIONS)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'])
    for (const [id, question] of Object.entries(QUESTIONS)) expect(id).toBe(`q${question.number}`)
  })

  it('registers each question as the function that answers it', () => {
    expect(QUESTIONS.q1.run).toBe(completionByModel)
    expect(QUESTIONS.q2.run).toBe(reviewerStrictness)
    expect(QUESTIONS.q3.run).toBe(usageByUnitAndRole)
    expect(QUESTIONS.q4.run).toBe(timeByUnit)
    expect(QUESTIONS.q5.run).toBe(catchesAndEscapes)
    expect(QUESTIONS.q6.run).toBe(checkOutcomes)
    expect(QUESTIONS.q7.run).toBe(determinism)
  })

  // q5 and q6 always name an unknown label-dependent figure when run with no labels (O5), and q7's
  // determinism figure is unknown regardless of the data (`apps/cli/specs/log-sync.md`) — neither is
  // the "nothing to read" case this test is after, so each names the unknown it still expects.
  const ALWAYS_UNKNOWN: Partial<Record<keyof typeof QUESTIONS, string[]>> = {
    q5: ['escapes'],
    q6: ['falseRejections'],
    q7: ['determinism']
  }

  it('answers over an empty dataset with no figure and a coverage that read nothing', () => {
    const dataset = createMemoryCache().dataset()
    for (const [id, question] of Object.entries(QUESTIONS)) {
      const expectedFigures = ALWAYS_UNKNOWN[id as keyof typeof QUESTIONS] ?? []
      const { coverage } = question.run(dataset)
      expect(coverage).toMatchObject({
        rowsRead: 0,
        lowTrustLeftOut: 0,
        unitUnknown: 0,
        rowsUsed: 0,
        gaps: 0,
        quarantined: 0
      })
      expect(coverage.unknowns.map((u) => u.figure)).toEqual(expectedFigures)
    }
  })
})
