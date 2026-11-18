import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  ALL_ATTRIBUTE_NAMES,
  ALL_EVENT_NAMES,
  ALL_SPAN_NAMES,
  ATTRIBUTE_NAMES,
  EVENT_NAMES,
  FORBIDDEN_CONTENT_ATTRIBUTES,
  GENAI_CONVENTIONS_VERSION,
  SPAN_NAMES
} from '../src/contract/catalogue.js'
import { harness } from './helpers.js'

test('GenAI names match the conventions spelling', () => {
  expect(SPAN_NAMES.run).toBe('invoke_workflow')
  expect(SPAN_NAMES.agent).toBe('invoke_agent')
  expect(SPAN_NAMES.step).toBe('execute_tool')
  expect(ATTRIBUTE_NAMES.operationName).toBe('gen_ai.operation.name')
  expect(ATTRIBUTE_NAMES.usageInputTokens).toBe('gen_ai.usage.input_tokens')
  expect(ATTRIBUTE_NAMES.usageOutputTokens).toBe('gen_ai.usage.output_tokens')
  expect(ATTRIBUTE_NAMES.errorType).toBe('error.type')
  expect(GENAI_CONVENTIONS_VERSION.length).toBeGreaterThan(0)
  for (const name of ALL_ATTRIBUTE_NAMES) expect(FORBIDDEN_CONTENT_ATTRIBUTES).not.toContain(name)
})

test('every name a handle function writes is in the catalogue', () => {
  const { handle, spans, logs, errors } = harness()
  handle.startRun()
  handle.alive()
  handle.stageChanged({ from: 'a', to: 'b' })
  handle.startRound({ number: 1 })
  handle.startPhase({ name: 'build' })
  handle.startAgent({ name: 'dev', id: 'x' })
  const step = handle.startStep({ tool: 'bash', toolType: 'function' })
  handle.endStep(step, { errorType: 'timeout' })
  handle.confidenceStated({ confidence: 80 })
  handle.recordUsage({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheWriteInputTokens: 4 })
  handle.endAgent()
  handle.endPhase()
  handle.endRound()
  handle.retried({ attempt: 2, reason: 'x' })
  handle.stopRuleMet({ rule: 'r' })
  handle.cancelled({ reason: 'c' })
  handle.exited({ code: 0 })
  handle.endRun()
  expect(errors).toEqual([])
  const finished = spans.getFinishedSpans()
  expect(finished.length).toBe(5 + 0)
  for (const s of finished) {
    expect(ALL_SPAN_NAMES).toContain(s.name)
    for (const k of Object.keys(s.attributes)) expect(ALL_ATTRIBUTE_NAMES).toContain(k)
  }
  const events = logs.getFinishedLogRecords()
  const seen = new Set(events.map((e) => e.eventName))
  for (const name of seen) expect(ALL_EVENT_NAMES).toContain(name as string)
  expect(seen.size).toBe(Object.values(EVENT_NAMES).length)
  for (const e of events) for (const k of Object.keys(e.attributes)) expect(ALL_ATTRIBUTE_NAMES).toContain(k)
})

test('the catalogue file imports nothing', () => {
  const source = readFileSync(new URL('../src/contract/catalogue.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/^import /m)
})
