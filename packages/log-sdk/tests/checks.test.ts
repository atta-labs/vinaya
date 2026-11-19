import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../src/index.js'
import { harness } from './helpers.js'

test('checks are measured by location and report individual results', () => {
  const { handle, spans, logs } = harness()
  for (const where of ['hook', 'local', 'push', 'ci'] as const) {
    const ref = handle.startChecks({ where })
    expect(logs.getFinishedLogRecords().at(-1)?.spanContext?.spanId).toBe(ref.spanId)
    expect(logs.getFinishedLogRecords().at(-1)?.eventName).toBe(E.checksStarted)
    handle.endChecks(ref, {
      ran: 2,
      passed: 1,
      failed: 1,
      skipped: 3,
      failedNames: ['lint'],
      ...(where === 'ci' ? { waitMs: 100, reruns: 1 } : {})
    })
    const span = spans.getFinishedSpans().at(-1)
    expect(span?.name).toBe(`vinaya.checks.${where}`)
    expect(span?.attributes).toMatchObject({
      [A.checksRan]: 2,
      [A.checksPassed]: 1,
      [A.checksFailed]: 1,
      [A.checksSkipped]: 3,
      [A.failedNames]: ['lint']
    })
    expect(span?.attributes[A.waitMs]).toBe(where === 'ci' ? 100 : undefined)
    expect(span?.attributes[A.reruns]).toBe(where === 'ci' ? 1 : undefined)
  }
  handle.checkNotPassed({ name: 'lint', result: 'failed' })
  handle.checkResultRead({ name: 'lint', result: 'passed' })
  const records = logs.getFinishedLogRecords().slice(-2)
  expect(records.map((r) => [r.eventName, r.attributes[A.checkName], r.attributes[A.result]])).toEqual([
    [E.checkNotPassed, 'lint', 'failed'],
    [E.checkResultRead, 'lint', 'passed']
  ])
})
