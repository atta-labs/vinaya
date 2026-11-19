import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../src/index.js'
import { harness } from './helpers.js'

test('review events carry identities, verdicts and counts without review text', () => {
  const { handle, logs } = harness()
  const finding = { id: 'f1', severity: 'high', place: 'example.ts:3', blocking: true, text: 'private finding' }
  const seat = { seat: 'code', verdict: 'revise', reasoning: 'private reasoning' }
  handle.reviewVerdicts({ seats: [seat], blockingCount: 1, findings: [finding] })
  handle.findingsCompared({ open: ['f1'], resolved: ['f2'], new: ['f3'], recurring: ['f4'] })
  const [verdicts, comparison] = logs.getFinishedLogRecords()
  expect(verdicts?.eventName).toBe(E.reviewVerdicts)
  expect(verdicts?.attributes).toMatchObject({
    [A.seats]: ['code'],
    [A.verdicts]: ['revise'],
    [A.blockingCount]: 1,
    [A.findingIds]: ['f1'],
    [A.findingSeverities]: ['high'],
    [A.findingPlaces]: ['example.ts:3'],
    [A.findingBlocking]: [true]
  })
  expect(JSON.stringify(verdicts?.attributes)).not.toContain('private')
  expect(comparison?.eventName).toBe(E.findingsCompared)
  expect(comparison?.attributes).toMatchObject({
    [A.findingsOpen]: ['f1'],
    [A.findingsResolved]: ['f2'],
    [A.findingsNew]: ['f3'],
    [A.findingsRecurring]: ['f4']
  })
})
