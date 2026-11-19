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

test('keeps exact IDs and uses an opaque dispatch seed key without exporting the prompt hash', () => {
  const start = fixtures.find((event) => event.event === 'dispatched')!
  const end = fixtures.find((event) => event.event === 'outcome_received')!
  const opaque = ['gh', 'p_opaque123'].join('')
  const meta = {
    ...start.meta,
    schema: 4,
    process_id: opaque,
    event_id: 'event-exact',
    actor_id: null,
    lineage: { run: null, attempt: null, parent: null },
    input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
    provenance: 'unavailable',
    process: { id: 'external', version: '9.1', digest: null },
    runner: { id: 'test', version: null },
    runtime: null,
    source: null,
    work: { ref: 'different-work', repo: null, change: null, revision: null },
    flow: { id: null, version: null }
  }
  const live = createLiveEarlierConverter(runId)
  const raised = live.convert(LogEventSchema.parse({ ...start, meta, effect_id: opaque, prompt_hash: opaque }))
  if (raised.type !== 'log') throw new Error('Expected a dispatch start')
  const key = `span:${spanIdFor(runId, `agent:${opaque}`)}`
  for (const [attribute, value] of [
    [A.spanKey, key],
    [A.eventId, 'event-exact'],
    [A.writerId, 'earlier:<redacted>'],
    [A.workRef, '412']
  ] as const)
    expect(raised.record.attributes).toContainEqual({ key: attribute, value: { stringValue: value } })
  expect(raised.record.attributes.some(({ key }) => key === 'vinaya.earlier.prompt_hash')).toBe(false)
  expect(raised.resource.attributes).toContainEqual({ key: A.serviceVersion, value: { stringValue: '9.1' } })
  const seeded = createLiveEarlierConverter(runId, [{ spanKey: key, startTimeUnixNano: raised.record.timeUnixNano }])
  const completed = seeded.convert(LogEventSchema.parse({ ...end, effect_id: opaque }))
  if (completed.type !== 'span') throw new Error('Expected a dispatch span')
  expect(completed.record.startTimeUnixNano).toBe(raised.record.timeUnixNano)
  expect(completed.record.spanId).toBe(raised.record.spanId)
  expect(JSON.stringify([raised, completed])).not.toContain(opaque)
})

test('matches out-of-order hand-off resolutions to the recorded reason', () => {
  const raised = fixtures.find((event) => event.kind === 'handoff' && event.event === 'raised')!
  const resolved = fixtures.find((event) => event.kind === 'handoff' && event.event === 'resolved')!
  const second = LogEventSchema.parse({
    ...raised,
    reason: 'other question',
    meta: {
      ...raised.meta,
      seq: raised.meta.seq + 1,
      ts: '2026-08-01T00:00:55.000Z'
    }
  })
  const end = LogEventSchema.parse({ ...resolved, reason: 'other question' })
  const live = createLiveEarlierConverter(runId)
  const seeds = [raised, second].map((event) => {
    const start = live.convert(event)
    if (start.type !== 'log') throw new Error('Expected a started event')
    const key = start.record.attributes.find((attr) => attr.key === A.spanKey)?.value
    if (key === undefined || !('stringValue' in key)) throw new Error('Expected a span key')
    return { spanKey: key.stringValue, startTimeUnixNano: start.record.timeUnixNano }
  })
  const seed = seeds[1]!
  for (const follower of [live, createLiveEarlierConverter(runId, seeds)]) {
    const completed = follower.convert(end)
    if (completed.type !== 'span') throw new Error('Expected a hand-off span')
    expect(completed.record.startTimeUnixNano).toBe(seed.startTimeUnixNano)
    expect(completed.record.spanId).toBe(spanIdFor(runId, seed.spanKey))
  }
})

test('a failure claims its agent span and a subsequent role attempt stays an earlier event', () => {
  const failure = fixtures.find((event) => event.event === 'dispatch_failed')!
  const attempt = fixtures.find((event) => event.kind === 'role_attempt')!
  const custom = fixtures.find((event) => event.kind === 'custom')!
  const live = createLiveEarlierConverter(runId)
  const failed = live.convert(LogEventSchema.parse({ ...failure, effect_id: 'e1', usage: { input: 7, output: 8 } }))
  expect(failed.record.attributes.some((attr) => attr.key === A.usageInputTokens)).toBe(false)
  const later = live.convert(attempt)
  expect(failed.type).toBe('span')
  if (later.type !== 'log') throw new Error('Expected a later role attempt log')
  expect(later.record.eventName).toBe('vinaya.earlier.role_attempt.attempted')
  const reported = live.convert(LogEventSchema.parse({ ...custom, name: E.runStarted }))
  if (reported.type !== 'log') throw new Error('Expected a custom log record')
  expect(reported.record.eventName).toBe('vinaya.earlier.custom.recorded')
  expect(reported.record.attributes).toContainEqual({
    key: 'vinaya.earlier.name',
    value: { stringValue: E.runStarted }
  })
  expect(reported.record.attributes).toContainEqual({ key: A.provenance, value: { stringValue: 'reported' } })
})

test('replayed starts preserve original times and ids derive from the run and round alone', () => {
  for (const [startName, endName] of [
    ['loop_started', 'journal_finalized'],
    ['round_started', 'round_ended']
  ]) {
    const start = fixtures.find((event) => event.event === startName)!
    const end = fixtures.find((event) => event.event === endName)!
    const replay = LogEventSchema.parse({ ...start, meta: { ...start.meta, seq: 90, ts: '2026-08-01T00:00:10.000Z' } })
    const otherStart = LogEventSchema.parse({ ...replay, loop_id: 'other-loop' })
    const otherEnd = LogEventSchema.parse({ ...end, loop_id: 'other-loop' })
    const whole = convertEarlierEvents([start, replay, otherStart, end, otherEnd])
    const spans = whole.traces.resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans))
    expect(spans).toHaveLength(2)
    expect(spans[0]?.spanId).toBe(spans[1]?.spanId)
    const first = createLiveEarlierConverter(runId).convert(start)
    if (first.type !== 'log') throw new Error('Expected started record')
    const key = first.record.attributes.find((attr) => attr.key === A.spanKey)?.value
    if (key === undefined || !('stringValue' in key)) throw new Error('Expected a start key')
    const seeded = createLiveEarlierConverter(runId, [
      { spanKey: key.stringValue, startTimeUnixNano: first.record.timeUnixNano }
    ])
    seeded.convert(replay)
    const completed = seeded.convert(end)
    if (completed.type !== 'span') throw new Error('Expected completed span')
    expect(completed.record.startTimeUnixNano).toBe(first.record.timeUnixNano)
    expect(spans[0]?.startTimeUnixNano).toBe(first.record.timeUnixNano)
  }
})

test('a standalone role attempt anchors steps at the shared agent span id', () => {
  const attempt = fixtures.find((event) => event.kind === 'role_attempt')!
  const usage = fixtures.find((event) => event.kind === 'usage')!
  if (attempt.kind !== 'role_attempt') throw new Error('Expected role attempt')
  const { traces } = convertEarlierEvents([attempt, usage])
  const span = traces.resourceSpans[0]?.scopeSpans[0]?.spans[0]
  expect(span?.spanId).toBe(spanIdFor(runId, `agent:${attempt.effect_id}`))
  expect(span?.parentSpanId).not.toBe(span?.spanId)
})

test('earlier finding metadata survives without finding descriptions', () => {
  const description = 'private finding text'
  const verdict = fixtures.find((event) => event.event === 'verdicts_read')!
  const dispatch = fixtures.find((event) => event.event === 'outcome_received')!
  const findings = [{ id: 'F1', severity: 'BLOCKER', description }]
  const live = createLiveEarlierConverter(runId)
  const records = [
    live.convert(LogEventSchema.parse({ ...verdict, findings })),
    live.convert(
      LogEventSchema.parse({
        ...dispatch,
        outcome: {
          type: 'verdict',
          verdict: 'REQUEST CHANGES',
          head: 'sha1',
          comment_id: 7,
          objectives: [],
          findings
        }
      })
    )
  ]
  for (const record of records) {
    const encoded = JSON.stringify(record)
    expect(encoded).not.toContain(description)
    expect(encoded).toContain('F1')
    expect(encoded).toContain('BLOCKER')
  }
})

test('a dispatch outcome has the same agent span and parent live and whole-run, with or without round_ended', () => {
  const start = fixtures.find((event) => event.event === 'round_started')!
  const end = fixtures.find((event) => event.event === 'round_ended')!
  const dispatch = fixtures.find((event) => event.event === 'outcome_received')!
  for (const events of [
    [start, dispatch],
    [start, dispatch, end]
  ]) {
    const whole = convertEarlierEvents(events)
    const wholeAgent = whole.traces.resourceSpans
      .flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans))
      .find((span) => span.name === 'invoke_agent')
    const live = createLiveEarlierConverter(runId)
    const liveAgent = events
      .map((event) => live.convert(event))
      .flatMap((item) => (item.type === 'span' ? [item.record] : []))
      .find((span) => span.name === 'invoke_agent')
    expect(wholeAgent?.parentSpanId).toBeDefined()
    expect(liveAgent).toEqual(wholeAgent)
  }
})

test('a role attempt followed by a dispatch start and end for one effect leaves no open start', () => {
  const attempt = fixtures.find((event) => event.kind === 'role_attempt')!
  const dispatchStart = fixtures.find((event) => event.event === 'dispatched')!
  const dispatchEnd = fixtures.find((event) => event.event === 'outcome_received')!
  if (attempt.kind !== 'role_attempt' || dispatchStart.kind !== 'dispatch' || dispatchEnd.kind !== 'dispatch') {
    throw new Error('Expected agent fixtures')
  }
  const effect_id = attempt.effect_id
  const live = createLiveEarlierConverter(runId)
  const first = live.convert(attempt)
  const started = live.convert(LogEventSchema.parse({ ...dispatchStart, effect_id }))
  const ended = live.convert(LogEventSchema.parse({ ...dispatchEnd, effect_id }))
  expect(first.type).toBe('span')
  for (const later of [started, ended]) {
    if (later.type !== 'log') throw new Error('Expected an earlier-format event')
    expect(later.record.eventName.startsWith('vinaya.earlier.')).toBe(true)
    expect(later.record.attributes.some((attr) => attr.key === A.spanKey)).toBe(false)
  }
})

test('a dispatch links to the round span the converter actually emits', () => {
  const start = fixtures.find((event) => event.event === 'round_started')!
  const end = fixtures.find((event) => event.event === 'round_ended')!
  const dispatch = fixtures.find((event) => event.event === 'outcome_received')!
  const { traces } = convertEarlierEvents([start, dispatch, end])
  const spans = traces.resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans))
  const agent = spans.find((span) => span.name === 'invoke_agent')
  const round = spans.find((span) => span.name === 'vinaya.round')
  expect(round?.spanId).toBeDefined()
  expect(agent?.parentSpanId).toBe(round?.spanId)
})

test('a custom field cannot spoof a stamp, and a later agent record keeps its usage', () => {
  const custom = fixtures.find((event) => event.kind === 'custom')!
  // The schema already rejects dotted field names; the converter holds the line on its own too.
  const spoofed = { ...custom, fields: { 'vinaya.event.id': 'fake', 'vinaya.writer.id': 'fake' } } as typeof custom
  const record = createLiveEarlierConverter(runId).convert(spoofed).record
  for (const key of [A.eventId, A.writerId]) {
    expect(record.attributes.filter((attr) => attr.key === key)).toHaveLength(1)
    expect(record.attributes.find((attr) => attr.key === key)?.value).not.toEqual({ stringValue: 'fake' })
  }
  const failure = fixtures.find((event) => event.event === 'dispatch_failed')!
  const attempt = fixtures.find((event) => event.kind === 'role_attempt')!
  const live = createLiveEarlierConverter(runId)
  live.convert(LogEventSchema.parse({ ...failure, effect_id: 'e9' }))
  const later = live.convert(LogEventSchema.parse({ ...attempt, effect_id: 'e9', usage: { input: 3, output: 4 } }))
  expect(later.record.attributes.some((attr) => attr.key === 'vinaya.earlier.usage')).toBe(true)
  expect(later.record.attributes.some((attr) => attr.key === A.usageInputTokens)).toBe(false)
})
