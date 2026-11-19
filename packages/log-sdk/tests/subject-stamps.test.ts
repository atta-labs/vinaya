import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A } from '../src/index.js'
import { harness } from './helpers.js'

test('subject records share writer sequencing and the answer uses the answering writer', () => {
  const a = harness({ provenance: 'governed', destination: { events: { 'team.done': { fields: {} } } } })
  const b = harness()
  const startTime = new Date(1_000)
  a.handle.reviewVerdicts({ seats: [], blockingCount: 0, findings: [] })
  const checks = a.handle.startChecks({ where: 'local' })
  a.handle.endChecks(checks, { ran: 0, passed: 0, failed: 0, skipped: 0, failedNames: [] })
  a.handle.recordChange({ kind: 'reverted', change: 'pr-1' })
  a.handle.forgeAction({ action: 'write', target: 'pr-1', result: 'success' })
  a.handle.custom('team.done', {})
  const question = a.handle.askPerson({ kind: 'strategy', key: 'choice', startTime })
  b.handle.alive()
  b.handle.answerPerson({ kind: 'strategy', spanId: question.spanId, startTime, by: 'principal' })
  const events = a.logs.getFinishedLogRecords()
  expect(events.map((event) => event.attributes[A.seq])).toEqual([1, 2, 4, 5, 6, 7])
  expect(new Set(events.map((event) => event.attributes[A.eventId])).size).toBe(events.length)
  for (const event of events) {
    expect(event.attributes).toMatchObject({ [A.writerId]: a.handle.writerId, [A.provenance]: 'governed' })
    expect(typeof event.attributes[A.eventId]).toBe('string')
  }
  expect(a.spans.getFinishedSpans()[0]?.attributes).toMatchObject({
    [A.seq]: 3,
    [A.writerId]: a.handle.writerId,
    [A.provenance]: 'governed'
  })
  expect(b.handle.writerId).not.toBe(a.handle.writerId)
  expect(b.spans.getFinishedSpans()[0]?.attributes).toMatchObject({
    [A.seq]: 2,
    [A.writerId]: b.handle.writerId,
    [A.provenance]: 'reported'
  })
})
