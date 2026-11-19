import { expect, test } from 'bun:test'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { harness } from './helpers.js'

const throwingProcessor: SpanProcessor = {
  onStart() {},
  onEnd() {
    throw new Error('boom')
  },
  async forceFlush() {},
  async shutdown() {}
}

test('a throwing processor reaches the error callback once and the call returns', () => {
  const { handle, errors } = harness({ spanProcessors: [throwingProcessor] })
  handle.run.started()
  expect(() => handle.run.ended()).not.toThrow()
  expect(errors.length).toBe(1)
  expect((errors[0] as Error).message).toBe('boom')
})

test('an invalid argument reaches the error callback once and the call returns', () => {
  const { handle, errors } = harness()
  // No run is open, so ending one is invalid.
  expect(() => handle.run.ended()).not.toThrow()
  expect(errors.length).toBe(1)
  expect(() => handle.usage.recorded({ inputTokens: 1 })).not.toThrow()
  expect(errors.length).toBe(2)
})

test('a throwing error callback does not escape', () => {
  const { handle } = harness({
    onError: () => {
      throw new Error('callback')
    }
  })
  expect(() => handle.run.ended()).not.toThrow()
})

test('a secret-shaped attribute value is recorded redacted', () => {
  const { handle, spans, logs } = harness()
  handle.run.started()
  // Assembled at run time so no credential-shaped literal sits in the file.
  const token = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')
  handle.agent.sent({ seat: `agent ${token}` })
  handle.run.stageChanged({ to: ['pass', 'word=', 'abcdefghijklmnopqrstuvwxyz'].join('') })
  handle.agent.returned()
  handle.run.ended()
  const agent = spans.getFinishedSpans().find((s) => s.name.startsWith('invoke_agent'))
  expect(agent?.name).toBe('invoke_agent agent <redacted>')
  expect(agent?.attributes['gen_ai.agent.name']).toBe('agent <redacted>')
  const moment = logs.getFinishedLogRecords().find((e) => e.eventName === 'vinaya.run.stage_changed')
  expect(moment?.attributes['vinaya.stage.to']).toBe('password=<redacted>')
})
