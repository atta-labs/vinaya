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
    const ref = ask.handle.person.asked({
      kind,
      key: kind,
      why: 'two_designs',
      decision: 'pick_one',
      startTime,
      ...(suppliedId ? { spanId: suppliedId } : {})
    })
    const started = ask.logs.getFinishedLogRecords().at(-1)
    expect(started?.eventName).toBe(E.personAsked)
    expect(started?.attributes).toMatchObject({ [A.personWhy]: 'two_designs', [A.personDecision]: 'pick_one' })
    expect(started?.spanContext?.spanId).toBe(suppliedId ?? spanIdFor('run-1', kind))
    expect(ask.spans.getFinishedSpans()).toEqual([])
    answer.handle.person.answered({ kind, spanId: ref.spanId, startTime, endTime, answer: 'option_a', by: 'principal' })
    const span = answer.spans.getFinishedSpans().at(-1)
    expect(span?.name).toBe(`vinaya.person ${kind}`)
    expect(span?.spanContext().spanId).toBe(started?.spanContext?.spanId)
    expect(span?.spanContext().traceId).toBe(started?.spanContext?.traceId)
    expect(span?.startTime).toEqual([1, 0])
    expect(span?.endTime).toEqual([5, 0])
    expect(span?.attributes).toMatchObject({
      [A.questionKind]: kind,
      [A.answeredBy]: 'principal',
      [A.personAnswer]: 'option_a'
    })
  }
  expect(answer.logs.getFinishedLogRecords()).toEqual([])
})

test('the handle that asked writes the span with the question it asked', () => {
  const { handle, spans, errors } = harness()
  const startTime = new Date(1_000)
  const ref = handle.person.asked({ kind: 'strategy', key: 'q', why: 'two_designs', decision: 'pick_one', startTime })
  handle.person.answered({ kind: 'strategy', spanId: ref.spanId, startTime, by: 'principal' })
  expect(errors).toEqual([])
  expect(spans.getFinishedSpans()[0]?.attributes).toMatchObject({
    [A.personWhy]: 'two_designs',
    [A.personDecision]: 'pick_one'
  })
})
