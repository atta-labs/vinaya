import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, spanIdFor, traceIdFor } from '../src/index.js'
import { harness } from './helpers.js'

test('change moments carry their fields and final events correlate only with an explicit run', () => {
  const { handle, logs, errors } = harness()
  handle.change.saved({ branch: 'topic', commit: 'abc' })
  handle.change.pushed({ result: 'passed', picked: 4, failed: 0, ms: 90 })
  handle.change.opened({ change: 'pr-1', commit: 'abc' })
  handle.change.conflicted({ reentry: 1 })
  handle.change.recovered()
  handle.change.merged({ runId: 'earlier-run', by: 'operator', when: new Date(2_000) })
  handle.change.reverted({ reason: 'policy' })
  handle.change.incident({ severity: 'high', link: 'https://example.test/i/1' })
  expect(errors).toEqual([])
  const records = logs.getFinishedLogRecords()
  expect(records.map((r) => r.eventName)).toEqual(
    ['saved', 'pushed', 'opened', 'conflicted', 'recovered', 'merged', 'reverted', 'incident'].map(
      (kind) => `vinaya.change.${kind}`
    )
  )
  expect(records[0]?.attributes).toMatchObject({ [A.branch]: 'topic', [A.commit]: 'abc' })
  expect(records[1]?.attributes).toMatchObject({
    [A.result]: 'passed',
    [A.changeTestsPicked]: 4,
    [A.changeTestsFailed]: 0,
    [A.changePushMs]: 90
  })
  expect(records[2]?.attributes).toMatchObject({ [A.change]: 'pr-1', [A.commit]: 'abc' })
  expect(records[3]?.attributes[A.changeReentry]).toBe(1)
  expect(records[5]?.attributes[A.actor]).toBe('operator')
  expect(records[5]?.hrTime[0]).toBe(2)
  expect(records[6]?.attributes[A.reason]).toBe('policy')
  expect(records[7]?.attributes).toMatchObject({ [A.severity]: 'high', [A.changeLink]: 'https://example.test/i/1' })
  expect(records[5]?.spanContext?.traceId).toBe(traceIdFor('earlier-run'))
  expect(records[5]?.attributes[A.runId]).toBe('earlier-run')
  expect(records[6]?.spanContext?.traceId).toBe(traceIdFor('run-1'))
  expect(records[7]?.spanContext?.traceId).toBe(traceIdFor('run-1'))
})

test('merged, reverted, incident and closed link to the handle run unless a run is given', () => {
  const { handle, logs, errors } = harness({ runId: 'change-run' })
  handle.change.merged({ by: 'operator' })
  handle.change.reverted({ reason: 'policy' })
  handle.change.incident({ severity: 'high' })
  handle.change.closed({ by: 'operator', when: new Date(3_000) })
  handle.change.closed({ runId: 'other-run' })
  expect(errors).toEqual([])
  const records = logs.getFinishedLogRecords()
  expect(records.map((r) => r.eventName)).toEqual(
    ['merged', 'reverted', 'incident', 'closed', 'closed'].map((kind) => `vinaya.change.${kind}`)
  )
  for (const own of records.slice(0, 4)) {
    expect(own.spanContext?.traceId).toBe(traceIdFor('change-run'))
    expect(own.spanContext?.spanId).toBe(spanIdFor('change-run', 'run'))
    expect(own.attributes[A.runId]).toBe('change-run')
  }
  expect(records[3]?.attributes[A.actor]).toBe('operator')
  expect(records[3]?.hrTime[0]).toBe(3)
  expect(records[4]?.spanContext?.traceId).toBe(traceIdFor('other-run'))
  expect(records[4]?.attributes[A.runId]).toBe('other-run')
})
