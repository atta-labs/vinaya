import { expect, test } from 'bun:test'
import { FORBIDDEN_CONTENT_ATTRIBUTES } from '../src/contract/catalogue.js'
import { harness, spanNamed } from './helpers.js'

test('agent, step and usage make invoke_agent and execute_tool spans', () => {
  const { handle, spans, errors } = harness()
  handle.run.started()
  const agent = handle.agent.sent({ seat: 'developer', id: 'dev-1' })
  const step = handle.agent.stepStarted({ tool: 'bash', callId: 'call-1' })
  handle.agent.stepEnded(step)
  handle.usage.recorded({ inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5 })
  handle.agent.returned({ outcome: 'done' })
  handle.run.ended()
  expect(errors).toEqual([])

  const [agentSpan] = spanNamed(spans, 'invoke_agent developer')
  const [stepSpan] = spanNamed(spans, 'execute_tool bash')
  expect(agentSpan?.attributes['gen_ai.operation.name']).toBe('invoke_agent')
  expect(agentSpan?.attributes['gen_ai.agent.name']).toBe('developer')
  expect(agentSpan?.attributes['gen_ai.usage.input_tokens']).toBe(10)
  expect(agentSpan?.attributes['gen_ai.usage.output_tokens']).toBe(20)
  expect(agentSpan?.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(5)
  expect(stepSpan?.attributes['gen_ai.tool.name']).toBe('bash')
  expect(stepSpan?.attributes['gen_ai.tool.call.id']).toBe('call-1')
  expect(stepSpan?.parentSpanContext?.spanId).toBe(agent.spanId)
  expect(stepSpan?.attributes['gen_ai.usage.input_tokens']).toBeUndefined()
})

test('an agent that failed ends with an error type and its usage-limit reset', () => {
  const { handle, spans, errors } = harness()
  handle.run.started()
  handle.agent.sent({ seat: 'developer' })
  handle.agent.failed({ errorType: 'usage_limit', resetAt: '2026-11-20T03:00:00Z' })
  expect(errors).toEqual([])
  const [span] = spanNamed(spans, 'invoke_agent developer')
  expect(span?.attributes['error.type']).toBe('usage_limit')
  expect(span?.attributes['vinaya.agent.reset_at']).toBe('2026-11-20T03:00:00Z')
  expect(span?.status.code).toBe(2)
})

test('tokens and a cost-unknown reason are both written; a cost wins over the reason; the old reason drops every figure', () => {
  const { handle, spans } = harness()
  handle.run.started()
  handle.agent.sent({ seat: 'developer' })
  handle.usage.recorded({ inputTokens: 10, outputTokens: 20, costUnknownReason: 'not_priced' })
  handle.agent.returned({ outcome: 'done' })
  handle.agent.sent({ seat: 'reviewer' })
  handle.usage.recorded({ inputTokens: 1, cost: { amount: 0.5, kind: 'exact' }, costUnknownReason: 'not_priced' })
  handle.agent.returned({ outcome: 'done' })
  handle.agent.sent({ seat: 'planner' })
  handle.usage.recorded({ inputTokens: 3, unknownReason: 'not_reported', costUnknownReason: 'not_priced' })
  handle.agent.returned({ outcome: 'done' })
  handle.run.ended()

  const [dev] = spanNamed(spans, 'invoke_agent developer')
  expect(dev?.attributes['gen_ai.usage.input_tokens']).toBe(10)
  expect(dev?.attributes['gen_ai.usage.output_tokens']).toBe(20)
  expect(dev?.attributes['vinaya.usage.cost_unknown_reason']).toBe('not_priced')
  expect(dev?.attributes['vinaya.usage.cost']).toBeUndefined()
  const [rev] = spanNamed(spans, 'invoke_agent reviewer')
  expect(rev?.attributes['vinaya.usage.cost']).toBe(0.5)
  expect(rev?.attributes['vinaya.usage.cost_unknown_reason']).toBeUndefined()
  const [plan] = spanNamed(spans, 'invoke_agent planner')
  expect(plan?.attributes['gen_ai.usage.input_tokens']).toBeUndefined()
  expect(plan?.attributes['vinaya.usage.unknown_reason']).toBe('not_reported')
  expect(plan?.attributes['vinaya.usage.cost_unknown_reason']).toBeUndefined()
})

test('no content attribute is ever set', () => {
  const { handle, spans, logs } = harness()
  handle.run.started()
  handle.agent.sent({ seat: 'a' })
  const step = handle.agent.stepStarted({ tool: 't' })
  handle.agent.stepEnded(step)
  handle.agent.returned()
  handle.run.ended()
  const keys = [
    ...spans.getFinishedSpans().flatMap((s) => Object.keys(s.attributes)),
    ...logs.getFinishedLogRecords().flatMap((e) => Object.keys(e.attributes))
  ]
  for (const forbidden of FORBIDDEN_CONTENT_ATTRIBUTES) expect(keys).not.toContain(forbidden)
})

test('a confidence statement is an event on the agent span', () => {
  const { handle, logs } = harness()
  handle.run.started()
  const agent = handle.agent.sent({ seat: 'a' })
  handle.agent.confidenceStated({ confidence: 85 })
  handle.agent.confidenceStated({ reason: 'not_given' })
  const [e, none] = logs.getFinishedLogRecords().filter((r) => r.eventName === 'vinaya.agent.confidence_stated')
  expect(e?.attributes['vinaya.confidence']).toBe(85)
  expect(e?.spanContext?.spanId).toBe(agent.spanId)
  expect('vinaya.confidence' in (none?.attributes ?? {})).toBe(false)
})
