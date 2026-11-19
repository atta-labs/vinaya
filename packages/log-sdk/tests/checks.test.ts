import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../src/index.js'
import { harness } from './helpers.js'

test('checks are measured by location and report individual results', () => {
  const { handle, spans, logs, errors } = harness()
  for (const where of ['hook', 'local', 'push', 'ci'] as const) {
    handle.checks.ran({
      where,
      ran: 2,
      passed: 1,
      failed: 1,
      skipped: 3,
      failedNames: ['lint'],
      startTime: new Date(1_000),
      endTime: new Date(3_000)
    })
    const span = spans.getFinishedSpans().at(-1)
    expect(span?.name).toBe(`vinaya.checks ${where}`)
    expect(span?.duration).toEqual([2, 0])
    expect(span?.attributes).toMatchObject({
      [A.checkWhere]: where,
      [A.checksRan]: 2,
      [A.checksPassed]: 1,
      [A.checksFailed]: 1,
      [A.checksSkipped]: 3,
      [A.failedNames]: ['lint']
    })
  }
  handle.checks.notPassed({ name: 'lint', version: '4', result: 'failed' })
  handle.checks.read({ round: 2, green: false })
  expect(errors).toEqual([])
  const records = logs.getFinishedLogRecords().slice(-2)
  expect(records.map((r) => [r.eventName, r.attributes[A.checkName], r.attributes[A.result]])).toEqual([
    [E.checkNotPassed, 'lint', 'failed'],
    [E.checkRead, undefined, undefined]
  ])
  expect(records[0]?.attributes[A.checkVersion]).toBe('4')
  expect(records[1]?.attributes).toMatchObject({ [A.roundNumber]: 2, [A.checksGreen]: false })
})

test('local, ci and rerun checks are their own spans', () => {
  const { handle, spans, errors } = harness()
  handle.checks.local({ passed: false })
  handle.checks.ci({ result: 'pending', waitMs: 50 })
  handle.checks.rerun({ failed: 1, affected: 2, total: 3 })
  expect(errors).toEqual([])
  const [local, ci, rerun] = spans.getFinishedSpans()
  expect([local?.name, ci?.name, rerun?.name]).toEqual([
    'vinaya.checks local',
    'vinaya.checks ci',
    'vinaya.checks rerun'
  ])
  expect(local?.attributes[A.result]).toBe('failed')
  expect(ci?.attributes[A.result]).toBe('pending')
  expect(ci?.attributes[A.waitMs]).toBe(50)
  expect(A.failedNames in (ci?.attributes ?? {})).toBe(false)
  expect(rerun?.attributes).toMatchObject({ [A.rerunFailed]: 1, [A.rerunAffected]: 2, [A.rerunTotal]: 3 })
})
