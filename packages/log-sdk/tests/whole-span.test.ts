import { expect, test } from 'bun:test'
import { type SpanParent, spanIdFor, traceIdFor } from '../src/contract/ids.js'
import { harness } from './helpers.js'

const trace = traceIdFor('run-1')

test('a span written whole carries the given id, parent, times, stamps and work ref', () => {
  const { handle, spans, errors } = harness({ workRef: 'issue-7' })
  const own: SpanParent = { traceId: trace, spanId: 'abcdabcdabcdabcd' }
  const parent: SpanParent = { traceId: trace, spanId: '1111111111111111' }
  handle.writeSpan('invoke_agent', own, parent, new Date(1_000), new Date(5_000), { 'gen_ai.agent.name': 'remote' })
  expect(errors).toEqual([])
  const [s] = spans.getFinishedSpans()
  expect(s?.spanContext().spanId).toBe(own.spanId)
  expect(s?.spanContext().traceId).toBe(trace)
  expect(s?.parentSpanContext?.spanId).toBe(parent.spanId)
  expect(s?.startTime).toEqual([1, 0])
  expect(s?.endTime).toEqual([5, 0])
  expect(s?.attributes['vinaya.seq']).toBe(1)
  expect(s?.attributes['vinaya.work.ref']).toBe('issue-7')
  expect(s?.attributes['gen_ai.agent.name']).toBe('remote')
})

test('a step given a parent span context is exported under that parent', () => {
  const { handle, spans } = harness()
  const remoteAgent: SpanParent = { traceId: trace, spanId: spanIdFor('run-1', 'agent-elsewhere') }
  const step = handle.startStep({ tool: 'bash', parent: remoteAgent })
  handle.endStep(step)
  expect(spans.getFinishedSpans()[0]?.parentSpanContext?.spanId).toBe(remoteAgent.spanId)
})

test('two handles of one run given the same key write the same span id', () => {
  const a = harness()
  const b = harness()
  const ra = a.handle.startAgent({ name: 'x', key: 'agent-1' })
  const rb = b.handle.startAgent({ name: 'x', key: 'agent-1' })
  expect(ra.spanId).toBe(rb.spanId)
  expect(ra.spanId).toBe(spanIdFor('run-1', 'agent-1'))
})

test('a caller-supplied span id wins over a key, and none gives a random id', () => {
  const { handle } = harness()
  const given = handle.startRound({ number: 1, spanId: 'ffffffffffffffff', key: 'k' })
  expect(given.spanId).toBe('ffffffffffffffff')
  const r1 = handle.startPhase({ name: 'a' })
  const r2 = handle.startPhase({ name: 'b' })
  expect(r1.spanId).not.toBe(r2.spanId)
})

test('a span of another trace is refused through the error callback', () => {
  const { handle, spans, errors } = harness()
  handle.writeSpan('invoke_agent', { traceId: traceIdFor('other'), spanId: 'abcdabcdabcdabcd' }, undefined, 1, 2)
  expect(errors.length).toBe(1)
  expect(spans.getFinishedSpans()).toEqual([])
})
