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

test('a how-to-answer text is on the asked event and on the whole person span, redacted', () => {
  const { handle, logs, spans, errors } = harness({ runId: 'how-to-run' })
  const secret = ['ghp', 'a'.repeat(36)].join('_')
  const ref = handle.person.asked({
    kind: 'authority',
    key: 'q',
    howToAnswer: `run vinaya answer --token ${secret}`,
    startTime: new Date(1_000)
  })
  handle.person.answered({ kind: 'authority', spanId: ref.spanId, by: 'principal', endTime: new Date(2_000) })
  expect(errors).toEqual([])
  const asked = logs.getFinishedLogRecords().find((r) => r.eventName === E.personAsked)
  expect(asked?.attributes[A.personHowToAnswer]).toBe('run vinaya answer --token <redacted>')
  expect(spans.getFinishedSpans()[0]?.attributes[A.personHowToAnswer]).toBe('run vinaya answer --token <redacted>')
  expect(spans.getFinishedSpans()[0]?.startTime).toEqual([1, 0])
})

test('a how-to-answer text is cut to the text cap, and with none the attribute is absent', () => {
  const { handle, logs, spans, errors } = harness({ runId: 'how-to-cap' })
  const startTime = new Date(1_000)
  const long = handle.person.asked({ kind: 'product', key: 'long', howToAnswer: 'x'.repeat(900), startTime })
  const none = handle.person.asked({ kind: 'strategy', key: 'none', startTime })
  handle.person.answered({ kind: 'product', spanId: long.spanId, by: 'principal' })
  handle.person.answered({ kind: 'strategy', spanId: none.spanId, by: 'principal' })
  expect(errors).toEqual([])
  const events = logs.getFinishedLogRecords().filter((r) => r.eventName === E.personAsked)
  expect(String(events[0]?.attributes[A.personHowToAnswer])).toHaveLength(500)
  expect(events[1]?.attributes).not.toHaveProperty(A.personHowToAnswer)
  const [product, strategy] = spans.getFinishedSpans()
  expect(String(product?.attributes[A.personHowToAnswer])).toHaveLength(500)
  expect(strategy?.attributes).not.toHaveProperty(A.personHowToAnswer)
})
