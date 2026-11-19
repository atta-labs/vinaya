import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A } from '../src/index.js'
import { harness } from './helpers.js'

test('subject records share writer sequencing and the answer uses the answering writer', () => {
  const a = harness({ provenance: 'governed', destination: { events: { 'team.done': { fields: {} } } } })
  const b = harness()
  const startTime = new Date(1_000)
  a.handle.review.verdicts({ seats: [], blockingCount: 0, findings: [] })
  a.handle.checks.ran({ where: 'local', ran: 0, passed: 0, failed: 0, skipped: 0, failedNames: [] })
  a.handle.change.reverted()
  a.handle.forge.written({ action: 'write', target: 'pr-1' })
  a.handle.custom.recorded('team.done', {})
  const question = a.handle.person.asked({ kind: 'strategy', key: 'choice', startTime })
  b.handle.run.alive()
  b.handle.person.answered({ kind: 'strategy', spanId: question.spanId, startTime, by: 'principal' })
  const events = a.logs.getFinishedLogRecords()
  expect(events.map((event) => event.attributes[A.seq])).toEqual([1, 3, 4, 5, 6])
  expect(new Set(events.map((event) => event.attributes[A.eventId])).size).toBe(events.length)
  for (const event of events) {
    expect(event.attributes).toMatchObject({ [A.writerId]: a.handle.writerId, [A.provenance]: 'governed' })
    expect(typeof event.attributes[A.eventId]).toBe('string')
  }
  expect(a.spans.getFinishedSpans()[0]?.attributes).toMatchObject({
    [A.seq]: 2,
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
