import { describe, expect, it } from 'vitest'
import { buildExecutions } from '../fixtures'
import { createMemoryCache, normalizeStoredLine, known } from '../sync'
import type { Dataset } from '../sync'
import { completionByModel } from './completion'
import { timeByUnit } from './time'
import { usageByUnitAndRole } from './usage'

/**
 * Every answer states the same coverage facts about the dataset it read: the
 * rows, the low-trust ones left out, the gaps and the quarantined lines.
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
    q3: usageByUnitAndRole(dataset),
    q4: timeByUnit(dataset)
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
