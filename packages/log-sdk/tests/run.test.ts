import { expect, test } from 'bun:test'
import { spanIdFor, traceIdFor } from '../src/contract/ids.js'
import { harness, spanNamed } from './helpers.js'

test('run, round and phase make spans with the right parentage', () => {
  const { handle, spans, errors } = harness()
  const run = handle.startRun()
  const round = handle.startRound({ number: 1 })
  const phase = handle.startPhase({ name: 'review' })
  handle.endPhase()
  handle.endRound()
  handle.endRun()
  expect(errors).toEqual([])

  const [runSpan] = spanNamed(spans, 'invoke_workflow')
  const [roundSpan] = spanNamed(spans, 'vinaya.round')
  const [phaseSpan] = spanNamed(spans, 'vinaya.phase')
  expect(runSpan?.spanContext().spanId).toBe(run.spanId)
  expect(run.spanId).toBe(spanIdFor('run-1', 'run'))
  expect(runSpan?.parentSpanContext).toBeUndefined()
  expect(roundSpan?.parentSpanContext?.spanId).toBe(run.spanId)
  expect(roundSpan?.spanContext().spanId).toBe(round.spanId)
  expect(phaseSpan?.parentSpanContext?.spanId).toBe(round.spanId)
  expect(phaseSpan?.spanContext().spanId).toBe(phase.spanId)
  expect(runSpan?.attributes['gen_ai.operation.name']).toBe('invoke_workflow')
  expect(roundSpan?.attributes['vinaya.round.number']).toBe(1)
  expect(phaseSpan?.attributes['vinaya.phase.name']).toBe('review')
  for (const s of spans.getFinishedSpans()) expect(s.spanContext().traceId).toBe(traceIdFor('run-1'))
})

test('every span start emits a started event with the span trace and span id', () => {
  const { handle, logs } = harness()
  const run = handle.startRun()
  const round = handle.startRound({ number: 2 })
  const phase = handle.startPhase({ name: 'p' })
  const events = logs.getFinishedLogRecords()
  expect(events.map((e) => e.eventName)).toEqual(['vinaya.run.started', 'vinaya.round.started', 'vinaya.phase.started'])
  for (const [e, ref] of [
    [events[0], run],
    [events[1], round],
    [events[2], phase]
  ] as const) {
    expect(e?.spanContext?.traceId).toBe(ref.traceId)
    expect(e?.spanContext?.spanId).toBe(ref.spanId)
  }
})

test('two handles given the same run id write into the same trace', () => {
  const a = harness()
  const b = harness()
  a.handle.startRun()
  b.handle.startRound({ number: 1 })
  a.handle.endRun()
  b.handle.endRound()
  expect(a.spans.getFinishedSpans()[0]?.spanContext().traceId).toBe(
    b.spans.getFinishedSpans()[0]?.spanContext().traceId
  )
  expect(a.handle.traceId).toBe(traceIdFor('run-1'))
})

test('single moments are events on the run span', () => {
  const { handle, logs } = harness()
  handle.startRun()
  handle.alive()
  handle.stageChanged({ from: 'plan', to: 'build' })
  handle.exited({ code: 3 })
  const events = logs.getFinishedLogRecords()
  expect(events.map((e) => e.eventName)).toEqual([
    'vinaya.run.started',
    'vinaya.run.alive',
    'vinaya.run.stage_changed',
    'vinaya.run.exited'
  ])
  expect(events[2]?.attributes['vinaya.stage.to']).toBe('build')
  expect(events[3]?.attributes['vinaya.exit.code']).toBe(3)
})
