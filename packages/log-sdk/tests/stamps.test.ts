import { expect, test } from 'bun:test'
import { harness } from './helpers.js'

function drive(h: ReturnType<typeof harness>) {
  h.handle.run.started()
  h.handle.run.alive()
  h.handle.round.started({ number: 1 })
  h.handle.round.ended()
  h.handle.run.ended()
}

const all = (h: ReturnType<typeof harness>) => [
  ...h.spans.getFinishedSpans().map((s) => s.attributes),
  ...h.logs.getFinishedLogRecords().map((e) => e.attributes)
]

test('one handle numbers its records 1, 2, 3 across spans and events', () => {
  const h = harness()
  drive(h)
  const records = all(h)
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

test('provenance is reported unless connect was told governed, and every record carries a trust', () => {
  const reported = harness()
  const governed = harness({ provenance: 'governed', trust: 'parent_attributed' })
  drive(reported)
  drive(governed)
  for (const a of all(reported)) {
    expect(a['vinaya.provenance']).toBe('reported')
    expect(a['vinaya.trust']).toBe('unavailable')
  }
  for (const a of all(governed)) {
    expect(a['vinaya.provenance']).toBe('governed')
    expect(a['vinaya.trust']).toBe('parent_attributed')
  }
})

test('work and input versions appear when named and are absent otherwise', () => {
  const bare = harness()
  drive(bare)
  for (const a of all(bare)) {
    for (const name of [
      'vinaya.work.ref',
      'vinaya.work.change',
      'vinaya.work.commit',
      'vinaya.input.brief',
      'vinaya.input.objectives',
      'vinaya.input.ruling',
      'vinaya.input.policy'
    ]) {
      expect(name in a, name).toBe(false)
    }
  }

  const named = harness({
    workRef: '42',
    work: { change: 'pr-7', commit: 'abc' },
    inputs: { brief: 'b1', objectives: 'o1', policy: 'p1' }
  })
  named.handle.run.started({ inputs: { ruling: 3 } })
  named.handle.run.alive()
  named.handle.run.ended()
  for (const a of all(named)) {
    expect(a['vinaya.work.ref']).toBe('42')
    expect(a['vinaya.work.change']).toBe('pr-7')
    expect(a['vinaya.work.commit']).toBe('abc')
    expect(a['vinaya.input.brief']).toBe('b1')
    expect(a['vinaya.input.objectives']).toBe('o1')
    expect(a['vinaya.input.ruling']).toBe('3')
    expect(a['vinaya.input.policy']).toBe('p1')
  }
})

test('the run names its work, and a later change names itself on every record after', () => {
  const h = harness()
  h.handle.run.started({ work: { ref: '9', title: 'Fix' } })
  h.handle.change.opened({ change: 'pr-1', commit: 'c1' })
  h.handle.run.alive()
  const [started, opened, alive] = h.logs.getFinishedLogRecords()
  expect(started?.attributes['vinaya.work.title']).toBe('Fix')
  expect(started?.attributes['vinaya.work.change']).toBeUndefined()
  expect(opened?.attributes['vinaya.work.change']).toBe('pr-1')
  expect(alive?.attributes['vinaya.work.commit']).toBe('c1')
  expect(alive?.attributes['vinaya.work.ref']).toBe('9')
})

test('records carry vinaya.round while a round is open and not after', () => {
  const h = harness()
  h.handle.run.started()
  h.handle.run.alive()
  h.handle.round.started({ number: 2 })
  h.handle.run.alive()
  h.handle.round.ended()
  h.handle.run.alive()
  h.handle.run.ended()
  const rounds = h.logs
    .getFinishedLogRecords()
    .filter((e) => e.eventName === 'vinaya.run.alive')
    .map((e) => e.attributes['vinaya.round'])
  expect(rounds).toEqual([undefined, 2, undefined])
  const roundSpan = h.spans.getFinishedSpans().find((s) => s.name === 'vinaya.round 2')
  expect(roundSpan?.attributes['vinaya.round']).toBe(2)
  const runSpan = h.spans.getFinishedSpans().find((s) => s.name === 'invoke_workflow')
  expect(runSpan?.attributes['vinaya.round']).toBeUndefined()
})

test('an agent span and every record inside it carry the seat', () => {
  const h = harness()
  h.handle.run.started()
  h.handle.run.alive()
  h.handle.agent.sent({ seat: 'reviewer' })
  const step = h.handle.agent.stepStarted({ tool: 'Bash' })
  h.handle.agent.confidenceStated({ confidence: 70 })
  h.handle.agent.stepEnded(step)
  h.handle.agent.returned()
  h.handle.run.alive()
  const events = h.logs.getFinishedLogRecords()
  const seats = events.map((e) => [e.eventName, e.attributes['vinaya.seat']])
  expect(seats).toEqual([
    ['vinaya.run.started', undefined],
    ['vinaya.run.alive', undefined],
    ['vinaya.agent.started', 'reviewer'],
    ['vinaya.step.started', 'reviewer'],
    ['vinaya.agent.confidence_stated', 'reviewer'],
    ['vinaya.run.alive', undefined]
  ])
  for (const name of ['invoke_agent reviewer', 'execute_tool Bash']) {
    expect(h.spans.getFinishedSpans().find((s) => s.name === name)?.attributes['vinaya.seat']).toBe('reviewer')
  }
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

test('a handle given no service version writes no service.version resource attribute', () => {
  const h = harness()
  drive(h)
  const res = h.spans.getFinishedSpans()[0]?.resource.attributes
  expect(res).toBeDefined()
  expect(Object.keys(res ?? {})).not.toContain('service.version')
  expect(res?.['vinaya.sdk.version']).toBeDefined()
})

test('a secret-shaped work title is redacted on events and spans', () => {
  const h = harness()
  const secret = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')
  h.handle.run.started({ work: { title: `title ${secret}` } })
  h.handle.run.alive()
  h.handle.run.ended()
  for (const a of all(h)) expect(String(a['vinaya.work.title'])).not.toContain(secret)
})

test('usage with an unknown reason records the reason and no figure', () => {
  const h = harness()
  h.handle.run.started()
  h.handle.agent.sent({ seat: 'a' })
  h.handle.usage.recorded({ unknownReason: 'not_reported', inputTokens: 5 })
  h.handle.agent.returned()
  const span = h.spans.getFinishedSpans().find((s) => s.name === 'invoke_agent a')
  expect(span?.attributes['vinaya.usage.unknown_reason']).toBe('not_reported')
  expect('gen_ai.usage.input_tokens' in (span?.attributes ?? {})).toBe(false)
})
