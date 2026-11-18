import { expect, test } from 'bun:test'
import { harness } from './helpers.js'

function drive(h: ReturnType<typeof harness>) {
  h.handle.startRun()
  h.handle.alive()
  h.handle.startRound({ number: 1 })
  h.handle.endRound()
  h.handle.endRun()
}

test('one handle numbers its records 1, 2, 3 across spans and events', () => {
  const h = harness()
  drive(h)
  const records = [
    ...h.spans.getFinishedSpans().map((s) => s.attributes),
    ...h.logs.getFinishedLogRecords().map((e) => e.attributes)
  ]
  const seqs = records.map((a) => a['vinaya.seq'] as number).sort((a, b) => a - b)
  expect(seqs).toEqual([1, 2, 3, 4, 5])
  expect(new Set(records.map((a) => a['vinaya.writer.id'])).size).toBe(1)
  expect(records.map((a) => a['vinaya.writer.id'])[0]).toBe(h.handle.writerId)
})

test("a span's number is above its started event's", () => {
  const h = harness()
  drive(h)
  const events = h.logs.getFinishedLogRecords()
  const startedRun = events.find((e) => e.eventName === 'vinaya.run.started')
  const runSpan = h.spans.getFinishedSpans().find((s) => s.name === 'invoke_workflow')
  expect(runSpan?.attributes['vinaya.seq'] as number).toBeGreaterThan(startedRun?.attributes['vinaya.seq'] as number)
})

test('two handles of one run carry different writer identifiers', () => {
  const a = harness()
  const b = harness()
  drive(a)
  drive(b)
  expect(a.handle.writerId).not.toBe(b.handle.writerId)
})

test('every event carries an event id unique within the run', () => {
  const a = harness()
  const b = harness()
  drive(a)
  drive(b)
  const ids = [...a.logs.getFinishedLogRecords(), ...b.logs.getFinishedLogRecords()].map(
    (e) => e.attributes['vinaya.event.id']
  )
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
  const first = a.logs.getFinishedLogRecords()[0]
  expect(first?.attributes['vinaya.event.id']).toBe(`${a.handle.writerId}:${first?.attributes['vinaya.seq']}`)
})

test('provenance is reported unless connect was told governed', () => {
  const reported = harness()
  const governed = harness({ provenance: 'governed' })
  drive(reported)
  drive(governed)
  for (const r of reported.logs.getFinishedLogRecords()) expect(r.attributes['vinaya.provenance']).toBe('reported')
  for (const s of reported.spans.getFinishedSpans()) expect(s.attributes['vinaya.provenance']).toBe('reported')
  for (const r of governed.logs.getFinishedLogRecords()) expect(r.attributes['vinaya.provenance']).toBe('governed')
  for (const s of governed.spans.getFinishedSpans()) expect(s.attributes['vinaya.provenance']).toBe('governed')
})

test('resource attributes are recorded once per handle', () => {
  const h = harness({ processName: 'driver', serviceVersion: '9.9.9' })
  drive(h)
  const res = h.spans.getFinishedSpans()[0]?.resource.attributes
  expect(res?.['service.name']).toBe('driver')
  expect(res?.['service.version']).toBe('9.9.9')
  expect(res?.['vinaya.repository']).toBe('acme/widgets')
  expect(String(res?.['host.id'])).toMatch(/^[0-9a-f]{32}$/)
  expect(res?.['vinaya.sdk.version']).toBeDefined()
  expect(res?.['vinaya.semconv.version']).toBeDefined()
})
