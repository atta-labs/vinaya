import { describe, expect, it } from 'vitest'
import { createMemoryCache } from '../sync'
import { completionByModel } from './completion'
import { QUESTIONS } from './index'
import { timeByUnit } from './time'
import { usageByUnitAndRole } from './usage'

describe('QUESTIONS', () => {
  it('holds one entry per question under its number: q1, q3 and q4', () => {
    expect(Object.keys(QUESTIONS)).toEqual(['q1', 'q3', 'q4'])
    for (const [id, question] of Object.entries(QUESTIONS)) expect(id).toBe(`q${question.number}`)
  })

  it('registers each question as the function that answers it', () => {
    expect(QUESTIONS.q1.run).toBe(completionByModel)
    expect(QUESTIONS.q3.run).toBe(usageByUnitAndRole)
    expect(QUESTIONS.q4.run).toBe(timeByUnit)
  })

  it('answers over an empty dataset with no figure and a coverage that read nothing', () => {
    const dataset = createMemoryCache().dataset()
    for (const question of Object.values(QUESTIONS)) {
      expect(question.run(dataset).coverage).toEqual({
        rowsRead: 0,
        lowTrustLeftOut: 0,
        unitUnknown: 0,
        rowsUsed: 0,
        gaps: 0,
        quarantined: 0,
        unknowns: []
      })
    }
  })
})
