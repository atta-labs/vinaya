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
  isSpanName,
  SPAN_NAMES,
  spanName
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
  const start = new Date(1_000)
  handle.run.started({ process: 'acme', seats: [{ seat: 'dev', model: 'm' }] })
  handle.run.alive()
  handle.run.stageChanged({ from: 'develop', to: 'review' })
  handle.round.started({ number: 1 })
  handle.phase.ended({ phase: 'review' })
  handle.agent.sent({ seat: 'dev', id: 'x' })
  const step = handle.agent.stepStarted({ tool: 'bash' })
  handle.agent.stepEnded(step, { errorType: 'timeout' })
  handle.agent.confidenceStated({ confidence: 80 })
  handle.usage.recorded({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3 })
  handle.agent.returned()
  handle.round.ended()
  handle.run.retried({ failed: 'x', tries: 2 })
  handle.run.stopRuleMet({ rule: 'approved' })
  handle.run.cancelled({ by: 'person' })
  handle.run.paused({ why: 'escalation', startTime: start })
  handle.run.resumed({ by: 'person' })
  handle.run.exited({ kind: 'finished', code: 0 })
  handle.review.verdicts({ seats: [], blockingCount: 0, findings: [] })
  handle.review.findingsCompared({ open: [], resolved: [], new: [], recurring: [] })
  for (const where of ['hook', 'local', 'push', 'ci'] as const) {
    handle.checks.ran({ where, ran: 0, passed: 0, failed: 0, skipped: 0, failedNames: [] })
  }
  handle.checks.local({ passed: true })
  handle.checks.ci({ result: 'green' })
  handle.checks.rerun({ failed: 0, affected: 0, total: 0 })
  handle.checks.notPassed({ name: 'lint', result: 'failed' })
  handle.checks.read({ green: true })
  handle.change.saved()
  handle.change.pushed({ result: 'passed' })
  handle.change.opened({ change: 'pr-1' })
  handle.change.conflicted()
  handle.change.recovered()
  handle.change.merged()
  handle.change.reverted()
  handle.change.incident()
  handle.change.closed()
  for (const kind of ['authority', 'strategy', 'product'] as const) {
    const ref = handle.person.asked({ kind, key: kind, startTime: start })
    handle.person.answered({ kind, spanId: ref.spanId, startTime: start, by: 'principal' })
  }
  const action = { action: 'write', target: 'pr-1' }
  handle.forge.validated(action)
  handle.forge.refused({ ...action, why: 'x' })
  handle.forge.written(action)
  handle.action.verified({ ...action, result: 'success' })
  handle.command.completed({ ...action, result: 'ok' })
  handle.run.ended()
  handle.usage.recorded({ agent: { traceId: handle.traceId, spanId: '1111111111111111' }, spanStart: '1000000' })
  expect(errors).toEqual([])
  const finished = spans.getFinishedSpans()
  const base = (name: string) => ALL_SPAN_NAMES.find((b) => name === b || name.startsWith(`${b} `))
  expect(new Set(finished.map((span) => base(span.name)))).toEqual(new Set(ALL_SPAN_NAMES))
  for (const s of finished) {
    expect(isSpanName(s.name)).toBe(true)
    for (const k of Object.keys(s.attributes)) expect(ALL_ATTRIBUTE_NAMES).toContain(k)
  }
  const events = logs.getFinishedLogRecords()
  const seen = new Set(events.map((e) => e.eventName))
  for (const name of seen) expect(ALL_EVENT_NAMES).toContain(name as string)
  expect(seen.size).toBe(Object.values(EVENT_NAMES).length)
  for (const e of events) for (const k of Object.keys(e.attributes)) expect(ALL_ATTRIBUTE_NAMES).toContain(k)
})

test('a span name is its base with the filled-in part, and nothing else is a span name', () => {
  expect(spanName(SPAN_NAMES.round, 3)).toBe('vinaya.round 3')
  expect(spanName(SPAN_NAMES.agent, 'reviewer')).toBe('invoke_agent reviewer')
  expect(spanName(SPAN_NAMES.run)).toBe('invoke_workflow')
  expect(isSpanName('vinaya.checks ci')).toBe(true)
  expect(isSpanName('vinaya.checks')).toBe(true)
  expect(isSpanName('vinaya.checkscloud')).toBe(false)
  expect(isSpanName('vinaya.invented 1')).toBe(false)
})

test('the catalogue file imports nothing', () => {
  const source = readFileSync(new URL('../src/contract/catalogue.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/^import /m)
})
