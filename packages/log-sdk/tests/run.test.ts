import { expect, test } from 'bun:test'
import { spanIdFor, traceIdFor } from '../src/contract/ids.js'
import type { Timers } from '../src/index.js'
import { harness, spanNamed } from './helpers.js'

/** A clock and timers a test drives by hand, so no real time passes. */
function fakeTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 1_000_000
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id as number)
    },
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = target
    }
  }
}

const alive = (h: ReturnType<typeof harness>) =>
  h.logs.getFinishedLogRecords().filter((e) => e.eventName === 'vinaya.run.alive')

test('run, round and phase make spans with the right parentage', () => {
  const { handle, spans, errors } = harness()
  const run = handle.run.started({ process: 'acme' })
  const round = handle.round.started({ number: 1 })
  handle.phase.ended({ phase: 'review' })
  handle.round.ended()
  handle.run.ended()
  expect(errors).toEqual([])

  const [runSpan] = spanNamed(spans, 'invoke_workflow acme')
  const [roundSpan] = spanNamed(spans, 'vinaya.round 1')
  const [phaseSpan] = spanNamed(spans, 'vinaya.phase review')
  expect(runSpan?.spanContext().spanId).toBe(run.spanId)
  expect(run.spanId).toBe(spanIdFor('run-1', 'run'))
  expect(runSpan?.parentSpanContext).toBeUndefined()
  expect(roundSpan?.parentSpanContext?.spanId).toBe(run.spanId)
  expect(roundSpan?.spanContext().spanId).toBe(round.spanId)
  expect(phaseSpan?.parentSpanContext?.spanId).toBe(round.spanId)
  expect(runSpan?.attributes['gen_ai.operation.name']).toBe('invoke_workflow')
  expect(roundSpan?.attributes['vinaya.round.number']).toBe(1)
  expect(phaseSpan?.attributes['vinaya.phase.name']).toBe('review')
  for (const s of spans.getFinishedSpans()) expect(s.spanContext().traceId).toBe(traceIdFor('run-1'))
})

test('a run with no process is the bare workflow span', () => {
  const { handle, spans } = harness()
  handle.run.started()
  handle.run.ended()
  expect(spanNamed(spans, 'invoke_workflow')).toHaveLength(1)
})

test('every span start emits a started event with the span trace and span id', () => {
  const { handle, logs } = harness()
  const run = handle.run.started()
  const round = handle.round.started({ number: 2 })
  const events = logs.getFinishedLogRecords()
  expect(events.map((e) => e.eventName)).toEqual(['vinaya.run.started', 'vinaya.round.started'])
  for (const [e, ref] of [
    [events[0], run],
    [events[1], round]
  ] as const) {
    expect(e?.spanContext?.traceId).toBe(ref.traceId)
    expect(e?.spanContext?.spanId).toBe(ref.spanId)
  }
})

test('two handles given the same run id write into the same trace', () => {
  const a = harness()
  const b = harness()
  a.handle.run.started()
  b.handle.round.started({ number: 1 })
  a.handle.run.ended()
  b.handle.round.ended()
  expect(a.spans.getFinishedSpans()[0]?.spanContext().traceId).toBe(
    b.spans.getFinishedSpans()[0]?.spanContext().traceId
  )
  expect(a.handle.traceId).toBe(traceIdFor('run-1'))
})

test('single moments are events on the run span', () => {
  const { handle, logs } = harness()
  handle.run.started()
  handle.run.alive()
  handle.run.stageChanged({ from: 'develop', to: 'review' })
  handle.run.exited({ kind: 'finished', code: 3 })
  const events = logs.getFinishedLogRecords()
  expect(events.map((e) => e.eventName)).toEqual([
    'vinaya.run.started',
    'vinaya.run.alive',
    'vinaya.run.stage_changed',
    'vinaya.run.exited'
  ])
  expect(events[2]?.attributes['vinaya.stage.to']).toBe('review')
  expect(events[3]?.attributes['vinaya.exit.code']).toBe(3)
  expect(events[3]?.attributes['vinaya.exit.kind']).toBe('finished')
})

test('a pause and its resume are one vinaya.pause span under the run', () => {
  const { handle, spans, errors } = harness()
  const run = handle.run.started()
  handle.round.started({ number: 2 })
  handle.run.paused({ why: 'escalation', startTime: new Date(1_000) })
  handle.run.resumed({ by: 'person', endTime: new Date(5_000) })
  expect(errors).toEqual([])
  const pauses = spanNamed(spans, 'vinaya.pause')
  expect(pauses).toHaveLength(1)
  expect(pauses[0]?.parentSpanContext?.spanId).toBe(run.spanId)
  expect(pauses[0]?.attributes['vinaya.round.number']).toBe(2)
  expect(pauses[0]?.attributes['vinaya.pause.why']).toBe('escalation')
  expect(pauses[0]?.attributes['vinaya.pause.by']).toBe('person')
  expect(pauses[0]?.duration).toEqual([4, 0])
})

test('a pause resumed by a second handle is still one span, with the round and why', () => {
  const first = harness()
  const second = harness()
  const pause = first.handle.run.paused({ round: 2, why: 'escalation', startTime: new Date(1_000) })
  expect(spanNamed(first.spans, 'vinaya.pause')).toHaveLength(0)
  second.handle.run.resumed({
    pause,
    by: 'run',
    startTime: new Date(1_000),
    round: 2,
    why: 'escalation',
    endTime: new Date(3_000)
  })
  expect(first.errors).toEqual([])
  expect(second.errors).toEqual([])
  const [span] = spanNamed(second.spans, 'vinaya.pause')
  expect(span?.spanContext().spanId).toBe(pause.spanId)
  expect(span?.spanContext().traceId).toBe(traceIdFor('run-1'))
  expect(span?.attributes['vinaya.round.number']).toBe(2)
  expect(span?.attributes['vinaya.pause.why']).toBe('escalation')
  expect(span?.attributes['vinaya.pause.by']).toBe('run')
})

test('a resume with no known start is refused and recorded nowhere', () => {
  const { handle, spans, errors } = harness()
  handle.run.resumed({ pause: { traceId: traceIdFor('run-1'), spanId: spanIdFor('run-1', 'pause') }, by: 'person' })
  expect(spanNamed(spans, 'vinaya.pause')).toHaveLength(0)
  expect(errors).toHaveLength(1)
})

test('alive is sent after two minutes with no record, and again every two minutes of silence', () => {
  const timers = fakeTimers()
  const h = harness({ timers })
  h.handle.run.started()
  h.handle.round.started({ number: 4 })
  h.handle.run.stageChanged({ to: 'review' })
  timers.advance(119_000)
  expect(alive(h)).toHaveLength(0)
  timers.advance(2_000)
  expect(alive(h)).toHaveLength(1)
  expect(alive(h)[0]?.attributes['vinaya.round.number']).toBe(4)
  expect(alive(h)[0]?.attributes['vinaya.phase.name']).toBe('review')
  timers.advance(120_000)
  expect(alive(h)).toHaveLength(2)
  expect(h.errors).toEqual([])
})

test('a busy run sends no alive', () => {
  const timers = fakeTimers()
  const h = harness({ timers })
  h.handle.run.started()
  for (let i = 0; i < 10; i++) {
    timers.advance(100_000)
    h.handle.run.stageChanged({ to: 'develop' })
  }
  expect(alive(h)).toHaveLength(0)
})

test('alive stops when the run ends, and when the handle shuts down', async () => {
  const ended = fakeTimers()
  const a = harness({ timers: ended })
  a.handle.run.started()
  a.handle.run.ended()
  expect(ended.pending()).toBe(0)
  ended.advance(600_000)
  expect(alive(a)).toHaveLength(0)

  const shut = fakeTimers()
  const b = harness({ timers: shut })
  b.handle.run.started()
  await b.handle.shutdown()
  expect(shut.pending()).toBe(0)
  shut.advance(600_000)
  expect(alive(b)).toHaveLength(0)
})

test('a handle that was never given a run sends no alive and holds no timer', () => {
  const timers = fakeTimers()
  const h = harness({ timers })
  h.handle.round.started({ number: 1 })
  expect(timers.pending()).toBe(0)
})
