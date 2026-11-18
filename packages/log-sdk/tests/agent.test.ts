import { expect, test } from 'bun:test'
import { FORBIDDEN_CONTENT_ATTRIBUTES } from '../src/contract/catalogue.js'
import { harness, spanNamed } from './helpers.js'

test('agent, step and usage make invoke_agent and execute_tool spans', () => {
  const { handle, spans, errors } = harness()
  handle.startRun()
  const agent = handle.startAgent({ name: 'developer', id: 'dev-1' })
  const step = handle.startStep({ tool: 'bash', toolType: 'function' })
  handle.endStep(step)
  handle.recordUsage({ inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5 })
  handle.endAgent({ usage: { cacheWriteInputTokens: 7 } })
  handle.endRun()
  expect(errors).toEqual([])

  const [agentSpan] = spanNamed(spans, 'invoke_agent')
  const [stepSpan] = spanNamed(spans, 'execute_tool')
  expect(agentSpan?.attributes['gen_ai.operation.name']).toBe('invoke_agent')
  expect(agentSpan?.attributes['gen_ai.agent.name']).toBe('developer')
  expect(agentSpan?.attributes['gen_ai.usage.input_tokens']).toBe(10)
  expect(agentSpan?.attributes['gen_ai.usage.output_tokens']).toBe(20)
  expect(agentSpan?.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(5)
  expect(agentSpan?.attributes['gen_ai.usage.cache_write.input_tokens']).toBe(7)
  expect(stepSpan?.attributes['gen_ai.tool.name']).toBe('bash')
  expect(stepSpan?.parentSpanContext?.spanId).toBe(agent.spanId)
  expect(stepSpan?.attributes['gen_ai.usage.input_tokens']).toBeUndefined()
})

test('no content attribute is ever set', () => {
  const { handle, spans, logs } = harness()
  handle.startRun()
  handle.startAgent({ name: 'a' })
  const step = handle.startStep({ tool: 't' })
  handle.endStep(step)
  handle.endAgent()
  handle.endRun()
  const keys = [
    ...spans.getFinishedSpans().flatMap((s) => Object.keys(s.attributes)),
    ...logs.getFinishedLogRecords().flatMap((e) => Object.keys(e.attributes))
  ]
  for (const forbidden of FORBIDDEN_CONTENT_ATTRIBUTES) expect(keys).not.toContain(forbidden)
})

test('a confidence statement is an event on the agent span', () => {
  const { handle, logs } = harness()
  handle.startRun()
  const agent = handle.startAgent({ name: 'a' })
  handle.confidenceStated({ confidence: 85 })
  const e = logs.getFinishedLogRecords().find((r) => r.eventName === 'vinaya.agent.confidence_stated')
  expect(e?.attributes['vinaya.confidence']).toBe(85)
  expect(e?.spanContext?.spanId).toBe(agent.spanId)
})
