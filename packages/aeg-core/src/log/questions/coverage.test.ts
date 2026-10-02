import { describe, expect, it } from 'vitest'
import { buildExecutions } from '../fixtures'
import { createMemoryCache, normalizeStoredLine, known } from '../sync'
import type { Dataset } from '../sync'
import { catchesAndEscapes } from './catches'
import { checkOutcomes } from './checks'
import { completionByModel } from './completion'
import { changeSizeBands, confidenceVsOutcome, outcomesByInstructionVersion, recurringFindings } from './convergence'
import { determinism } from './determinism'
import { reviewerStrictness } from './judgment'
import { timeByUnit } from './time'
import { usageByUnitAndRole } from './usage'

/**
 * Every answer states the same coverage facts about the dataset it read: the
 * rows, the low-trust ones left out, the gaps and the quarantined lines. q5
 * and q6 are run with no labels, so their own label-dependent figures are
 * unknown too — `reason` is checked the same as every other unknown here.
 */

function datasetWithGap(): Dataset {
  const cache = createMemoryCache()
  for (const [position, line] of buildExecutions()
    .flatMap((execution) => execution.lines)
    .entries()) {
    cache.put(normalizeStoredLine(line.raw, { source: 'fixtures', position: String(position) }))
  }
  cache.recordGap({ source: 'fixtures', from: '10', to: '20', reason: 'rotated away', lost: known(11) })
  return cache.dataset()
}

describe('every answer states its coverage', () => {
  const dataset = datasetWithGap()
  const answers = {
    q1: completionByModel(dataset),
    q2: reviewerStrictness(dataset),
    q3: usageByUnitAndRole(dataset),
    q4: timeByUnit(dataset),
    q5: catchesAndEscapes(dataset),
    q6: checkOutcomes(dataset),
    q7: determinism(dataset),
    q8: recurringFindings(dataset),
    q9: outcomesByInstructionVersion(dataset),
    q10: changeSizeBands(dataset),
    confidence: confidenceVsOutcome(dataset)
  }

  for (const [name, answer] of Object.entries(answers)) {
    it(`${name} counts the rows read, the low-trust rows left out, the gap and the quarantined lines`, () => {
      expect(answer.coverage).toMatchObject({ rowsRead: 93, lowTrustLeftOut: 3, gaps: 1, quarantined: 2 })
    })

    it(`${name} gives a reason for every figure it lists as unknown`, () => {
      for (const unknown of answer.coverage.unknowns) {
        expect(unknown.figure).not.toBe('')
        expect(unknown.reason).not.toBe('')
      }
    })
  }
})
