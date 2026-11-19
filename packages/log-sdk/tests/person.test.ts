import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, spanIdFor } from '../src/index.js'
import { harness } from './helpers.js'

test('a later handle writes the span announced when a person was asked', () => {
  const ask = harness()
  const answer = harness()
  const startTime = new Date(1_000)
  const endTime = new Date(5_000)
  for (const kind of ['authority', 'strategy', 'product'] as const) {
    const suppliedId = kind === 'product' ? 'abcdabcdabcdabcd' : undefined
    const ref = ask.handle.askPerson({ kind, key: kind, startTime, ...(suppliedId ? { spanId: suppliedId } : {}) })
    const started = ask.logs.getFinishedLogRecords().at(-1)
    expect(started?.eventName).toBe(E.personAsked)
    expect(started?.spanContext?.spanId).toBe(suppliedId ?? spanIdFor('run-1', kind))
    expect(ask.spans.getFinishedSpans()).toEqual([])
    answer.handle.answerPerson({ kind, spanId: ref.spanId, startTime, endTime, by: 'principal' })
    const span = answer.spans.getFinishedSpans().at(-1)
    expect(span?.name).toBe(`vinaya.person.${kind}`)
    expect(span?.spanContext().spanId).toBe(started?.spanContext?.spanId)
    expect(span?.spanContext().traceId).toBe(started?.spanContext?.traceId)
    expect(span?.startTime).toEqual([1, 0])
    expect(span?.endTime).toEqual([5, 0])
    expect(span?.attributes).toMatchObject({ [A.questionKind]: kind, [A.answeredBy]: 'principal' })
  }
  expect(answer.logs.getFinishedLogRecords()).toEqual([])
})
