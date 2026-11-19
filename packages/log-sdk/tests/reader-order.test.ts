import { expect, test } from 'bun:test'
import { createOrdering, EARLIER_WRITER_PREFIX, EVENT_NAMES as E, type OtelRecord } from '../src/index.js'

function event(writerId: string | null, seq: number | null, time: number, extra: Partial<OtelRecord> = {}): OtelRecord {
  return {
    kind: 'event',
    traceId: 't'.repeat(32),
    spanId: 's'.repeat(16),
    parentSpanId: null,
    name: 'something.happened',
    startTime: null,
    time: String(time),
    attributes: {},
    resource: {},
    seq,
    writerId,
    eventId: writerId === null || seq === null ? null : `${writerId}:${seq}`,
    provenance: 'reported',
    source: 'copy',
    ...extra
  }
}

const labels = (records: OtelRecord[]) => records.map(({ writerId, seq }) => `${writerId}${seq}`)

test('each writer comes out in sequence order and the writers are interleaved by time', () => {
  const ordering = createOrdering()
  const { ready, gaps } = ordering.push([
    event('b', 1, 25),
    event('a', 2, 30),
    event('a', 1, 10),
    event('b', 0, 5),
    event('a', 0, 1)
  ])
  expect(gaps).toEqual([])
  expect(labels(ready)).toEqual(['a0', 'b0', 'a1', 'b1', 'a2'])
})

test("a late record of one writer is still handed in that writer's order during a live follow", () => {
  const ordering = createOrdering()
  expect(labels(ordering.push([event('a', 0, 100), event('a', 1, 110)]).ready)).toEqual(['a0', 'a1'])
  // Writer b's records arrive after a later-timed record of a, in b's own order.
  expect(labels(ordering.push([event('b', 1, 60), event('b', 0, 50)]).ready)).toEqual(['b0', 'b1'])
  // A record that skips ahead is held until the number before it comes.
  expect(ordering.push([event('a', 3, 130)]).ready).toEqual([])
  expect(labels(ordering.push([event('a', 2, 120)]).ready)).toEqual(['a2', 'a3'])
})

test('a duplicate identity is dropped, held or already handed', () => {
  const ordering = createOrdering()
  const first = ordering.push([event('a', 0, 1), event('a', 0, 1)])
  expect(labels(first.ready)).toEqual(['a0'])
  expect(first.duplicates).toBe(1)
  expect(ordering.push([event('a', 0, 1)]).duplicates).toBe(1)
  ordering.push([event('a', 5, 9)])
  expect(ordering.push([event('a', 5, 9)]).duplicates).toBe(1)
  const span = (spanId: string): OtelRecord =>
    event(null, null, 5, { kind: 'span', spanId, startTime: '1', name: 'vinaya.round 1' })
  expect(createOrdering().push([span('1'.repeat(16)), span('1'.repeat(16)), span('2'.repeat(16))]).ready).toHaveLength(
    2
  )
})

test('a started event without its span is an open span until the span arrives', () => {
  const ordering = createOrdering()
  const started = event('a', 0, 1, { kind: 'started', name: E.roundStarted, spanId: 'r'.repeat(16) })
  const { ready } = ordering.push([started])
  expect(ready).toHaveLength(1)
  expect(ordering.openSpans()).toEqual([started])
  const span = event('a', 1, 9, { kind: 'span', name: 'vinaya.round 1', spanId: 'r'.repeat(16), startTime: '1' })
  ordering.push([span])
  expect(ordering.openSpans()).toEqual([])
  // A started event whose span was handed first is not open.
  const late = event('a', 2, 10, { kind: 'started', name: E.roundStarted, spanId: 'r'.repeat(16) })
  ordering.push([late])
  expect(ordering.openSpans()).toEqual([])
})

test('a missing number is a gap with its place, reported after the patience and never skipped silently', () => {
  const ordering = createOrdering({ patience: 2 })
  expect(labels(ordering.push([event('a', 0, 1), event('a', 1, 2), event('a', 4, 5)]).ready)).toEqual(['a0', 'a1'])
  const second = ordering.push([])
  expect(second.gaps).toEqual([
    {
      kind: 'sequence',
      writerId: 'a',
      place: 'writer a sequence 2–3',
      detail: 'sequence 2–3 of writer a never arrived'
    }
  ])
  expect(labels(second.ready)).toEqual(['a4'])
})

test('a flush hands every held record and reports every missing number', () => {
  const ordering = createOrdering()
  ordering.push([event('a', 0, 1), event('a', 2, 3), event('b', 0, 2), event('b', 5, 7)])
  const flushed = ordering.flush()
  expect(labels(flushed.ready)).toEqual(['a2', 'b5'])
  expect(flushed.gaps.map(({ place }) => place)).toEqual(['writer a sequence 1', 'writer b sequence 1–4'])
  expect(ordering.flush()).toEqual({ ready: [], gaps: [], duplicates: 0 })
})

test('writers of the earlier format report no sequence gap, and records with no sequence number keep their arrival order', () => {
  const ordering = createOrdering()
  const earlier = `${EARLIER_WRITER_PREFIX}run-1`
  const { ready, gaps } = ordering.push([
    event(earlier, 0, 1),
    event(earlier, 0, 2, { eventId: 'run-1:other' }),
    event(earlier, 7, 3),
    event(null, null, 4, { name: 'x' }),
    event(null, null, 5, { name: 'y' })
  ])
  expect(gaps).toEqual([])
  expect(ready.map(({ name }) => name)).toHaveLength(5)
  expect(ordering.flush().gaps).toEqual([])
  expect(ready.slice(-2).map(({ name }) => name)).toEqual(['x', 'y'])
})
