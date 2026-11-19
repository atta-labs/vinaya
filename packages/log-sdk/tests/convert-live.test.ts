import { expect, test } from 'bun:test'
import {
  ATTRIBUTE_NAMES as A,
  convertEarlierEvents,
  createLiveEarlierConverter,
  EVENT_NAMES as E,
  LogEventSchema,
  spanIdFor,
  traceIdFor
} from '../src/index.js'

const fixtures = (await Bun.file(new URL('./fixtures/earlier-events.jsonl', import.meta.url)).text())
  .trim()
  .split('\n')
  .map((line) => LogEventSchema.parse(JSON.parse(line)))
const runId = 'run-historical'

test('live records match whole-run records plus the paired started events', () => {
  const live = createLiveEarlierConverter(runId)
  const streamed = fixtures.map((event) => live.convert(event))
  const spans = streamed.flatMap((item) => (item.type === 'span' ? [item.record] : []))
  const logs = streamed.flatMap((item) => (item.type === 'log' ? [item.record] : []))
  const whole = convertEarlierEvents(fixtures)
  const starts = spans.flatMap((span) => span.events ?? [])
  const pairedIds = new Set(starts.map((start) => start.attributes.find((attr) => attr.key === A.eventId)?.value))
  expect(spans).toEqual(whole.traces.resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans)))
  expect(logs.filter((log) => !pairedIds.has(log.attributes.find((attr) => attr.key === A.eventId)?.value))).toEqual(
    whole.logs.resourceLogs.flatMap((group) => group.scopeLogs.flatMap((scope) => scope.logRecords))
  )
  expect(
    logs.filter((log) => pairedIds.has(log.attributes.find((attr) => attr.key === A.eventId)?.value))
  ).toHaveLength(starts.length)
  for (const { record } of streamed) {
    expect(record.attributes).toContainEqual({ key: A.workRef, value: { stringValue: '412' } })
    expect(record.attributes).toContainEqual({
      key: A.seq,
      value: { intValue: String(streamed.findIndex((item) => item.record === record)) }
    })
  }
  const usage = logs.find((log) => log.eventName === 'vinaya.earlier.usage.observed')!
  expect(usage.attributes.some(({ key }) => key.startsWith('gen_ai.usage.'))).toBe(false)
})

test('a follower can seed a cross-process start from the emitted key and time', () => {
  for (const [kind, startName, endName] of [
    ['dev_review_loop', 'paused', 'resumed'],
    ['handoff', 'raised', 'resolved']
  ]) {
    const start = fixtures.find((event) => event.kind === kind && event.event === startName)!
    const end = fixtures.find((event) => event.kind === kind && event.event === endName)!
    const first = createLiveEarlierConverter(runId).convert(start)
    if (first.type !== 'log') throw new Error('Expected an immediate started event')
    expect(first.record.eventName).toBe(E.personAsked)
    const key = first.record.attributes.find((attr) => attr.key === A.spanKey)?.value
    if (key === undefined || !('stringValue' in key)) throw new Error('Expected a span key')
    const seed = { spanKey: key.stringValue, startTimeUnixNano: first.record.timeUnixNano }
    const follower = createLiveEarlierConverter(runId, [seed])
    const second = follower.convert(end)
    if (second.type !== 'span') throw new Error('Expected the completed span')
    expect(second.record.startTimeUnixNano).toBe(seed.startTimeUnixNano)
    expect(second.record.endTimeUnixNano).toBe(String(BigInt(Date.parse(end.meta.ts)) * 1_000_000n))
    expect(second.record.spanId).toBe(spanIdFor(runId, seed.spanKey))
    expect(second.record.traceId).toBe(traceIdFor(runId))
    const repeatedEnd = follower.convert(end)
    if (repeatedEnd.type !== 'span') throw new Error('Expected a standalone end span')
    expect(repeatedEnd.record.startTimeUnixNano).toBe(repeatedEnd.record.endTimeUnixNano)
  }
})
