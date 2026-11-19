import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, traceIdFor } from '../src/index.js'
import { harness } from './helpers.js'

test('change moments carry metadata and final events correlate only with an explicit run', () => {
  const { handle, logs } = harness()
  const moments = ['saved', 'pushed', 'opened', 'conflicted', 'recovered', 'merged', 'reverted', 'incident'] as const
  for (const kind of moments) {
    handle.recordChange({
      kind,
      change: 'pr-1',
      branch: 'topic',
      commit: 'abc',
      by: 'operator',
      reason: 'policy',
      severity: 'high',
      ...(kind === 'merged' ? { runId: 'earlier-run' } : {})
    })
  }
  const records = logs.getFinishedLogRecords()
  expect(records.map((r) => r.eventName)).toEqual(moments.map((kind) => `vinaya.change.${kind}`))
  for (const event of records) {
    expect(event.attributes).toMatchObject({
      [A.change]: 'pr-1',
      [A.branch]: 'topic',
      [A.commit]: 'abc',
      [A.actor]: 'operator',
      [A.reason]: 'policy',
      [A.severity]: 'high'
    })
  }
  expect(records[5]?.spanContext?.traceId).toBe(traceIdFor('earlier-run'))
  expect(records[6]?.spanContext).toBeUndefined()
  expect(records[7]?.spanContext).toBeUndefined()
})
