import { expect, test } from 'bun:test'
import {
  agentSpanIdFor,
  ATTRIBUTE_NAMES as A,
  convertEarlierEvents,
  EVENT_NAMES as E,
  LogEventSchema,
  type LogEvent,
  ALL_ATTRIBUTE_NAMES,
  ALL_EVENT_NAMES,
  EARLIER_EVENT_PREFIX,
  isSpanName,
  SPAN_NAMES as S,
  spanName,
  traceIdFor
} from '../src/index.js'

const fixtures = (await Bun.file(new URL('./fixtures/earlier-events.jsonl', import.meta.url)).text())
  .trim()
  .split('\n')
  .map((line) => LogEventSchema.parse(JSON.parse(line)))

const fieldOf = (event: LogEvent, key: string): string | undefined =>
  String((event as unknown as Record<string, unknown>)[key])
const processOf = (event: LogEvent) => (event.meta.schema === 4 ? event.meta.process.id : undefined)
const whereOf = (event: LogEvent) =>
  ({ hook: 'hook', cli: 'local', loop: 'local', ci: 'ci' })[event.meta.host as string]

/** The span or event name the Log SDK's own handle writes for what each earlier event records. */
const expected: Record<string, (event: LogEvent) => string> = {
  'dev_review_loop.loop_started': () => E.runStarted,
  'dev_review_loop.round_started': () => E.roundStarted,
  'dev_review_loop.gate_result_read': () => E.checkRead,
  'dev_review_loop.verdicts_read': () => E.reviewVerdicts,
  'dev_review_loop.findings_compared': () => E.findingsCompared,
  'dev_review_loop.stop_condition_met': () => E.stopRuleMet,
  'dev_review_loop.paused': () => E.pauseStarted,
  'dev_review_loop.resumed': () => S.pause,
  'dev_review_loop.cancelled': () => E.cancelled,
  'dev_review_loop.unpushed_work_resume': () => E.changeRecovered,
  'dev_review_loop.infrastructure_retry': () => E.retried,
  'dev_review_loop.driver_heartbeat': () => E.alive,
  'dev_review_loop.conflict_reentry': () => E.changeConflicted,
  'dev_review_loop.storage_push': () => E.changeSaved,
  'dev_review_loop.local_checks_run': () => spanName(S.checks, 'local'),
  'dev_review_loop.ready_push': () => E.changePushed,
  'dev_review_loop.failed_tests_rerun': () => spanName(S.checks, 'rerun'),
  'dev_review_loop.pr_opened': () => E.changeOpened,
  'dev_review_loop.ci_result_read': () => spanName(S.checks, 'ci'),
  'dev_review_loop.phase_time': (e) => spanName(S.phase, fieldOf(e, 'phase')),
  'dev_review_loop.driver_exited': () => E.exited,
  'dev_review_loop.round_ended': (e) => spanName(S.round, fieldOf(e, 'round')),
  'dev_review_loop.journal_finalized': (e) => spanName(S.run, processOf(e)),
  'dispatch.dispatched': () => E.agentStarted,
  'dispatch.outcome_received': (e) => spanName(S.agent, fieldOf(e, 'target_role')),
  'dispatch.dispatch_failed': (e) => spanName(S.agent, fieldOf(e, 'target_role')),
  'role_attempt.attempted': (e) => spanName(S.agent, e.subject.role),
  'usage.observed': () => 'vinaya.earlier.usage.observed',
  'forge_write.validated': () => E.forgeValidated,
  'forge_write.refused': () => E.forgeRefused,
  'forge_write.written': () => E.forgeWritten,
  'gate.checked': () => E.checkNotPassed,
  'gate.summary': (e) => spanName(S.checks, whereOf(e)),
  'operation.completed': () => E.commandCompleted,
  'handoff.raised': () => E.personAsked,
  'handoff.resolved': (e) => spanName(S.person, fieldOf(e, 'class')),
  'effect.attempted': () => E.actionVerified,
  'effect.observed': () => E.actionVerified,
  'effect.verified': () => E.actionVerified,
  'custom.recorded': () => 'team.shipped'
}

function records(events: readonly LogEvent[]) {
  const { traces, logs } = convertEarlierEvents(events)
  return {
    spans: traces.resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans)),
    logs: logs.resourceLogs.flatMap((group) => group.scopeLogs.flatMap((scope) => scope.logRecords))
  }
}

test('each literal fixture converts to the expected record and carries its earlier identity', () => {
  for (const event of fixtures) {
    const pair = `${event.kind}.${event.event}`
    const name = expected[pair]?.(event)
    if (name === undefined) throw new Error(`Missing expected record for ${pair}`)
    const { spans, logs } = records([event])
    const emitted = [...spans, ...logs]
    expect(
      emitted.map((record) => ('name' in record ? record.name : record.eventName)),
      pair
    ).toEqual([name])
    expect(emitted[0]?.attributes).toContainEqual({
      key: A.eventId,
      value: { stringValue: `${event.meta.run_id}:${event.meta.seq}` }
    })
    expect(emitted[0]?.attributes).toContainEqual({
      key: A.provenance,
      value: { stringValue: event.kind === 'custom' ? 'reported' : 'governed' }
    })
  }
})

test('completed pairs keep both times and input tokens occur once per effect', () => {
  const { spans, logs } = records(fixtures)
  const run = spans.find((span) => span.name === S.run || span.name.startsWith(`${S.run} `))
  expect(run?.startTimeUnixNano).toBe('1785542400000000000')
  expect(run?.endTimeUnixNano).toBe('1785542422000000000')
  const dispatch = spans.find((span) => span.spanId === agentSpanIdFor('run-historical', 'e1'))
  expect(dispatch?.traceId).toBe(traceIdFor('run-historical'))
  expect(dispatch?.events?.[0]?.name).toBe(E.agentStarted)
  expect(dispatch?.startTimeUnixNano).toBe('1785542423000000000')
  expect(dispatch?.endTimeUnixNano).toBe('1785542424000000000')
  const failed = spans.find((span) => span.spanId === agentSpanIdFor('run-historical', 'e2'))
  expect(failed?.startTimeUnixNano).toBe(failed?.endTimeUnixNano)
  const tokenCounts = (events: readonly LogEvent[]) =>
    records(events).spans.flatMap((span) => span.attributes.filter((attribute) => attribute.key === A.usageInputTokens))
  const tokens = [{ key: A.usageInputTokens, value: { intValue: '100' } }]
  expect(tokenCounts(fixtures)).toEqual(tokens)
  const attempt = fixtures.find((event) => event.kind === 'role_attempt')!
  const outcome = fixtures.find((event) => event.event === 'outcome_received')!
  expect(tokenCounts([attempt, outcome])).toEqual(tokens)
  expect(records([attempt, outcome]).spans[0]?.attributes).toContainEqual(tokens[0]!)
  expect(logs.find((event) => event.eventName === 'vinaya.earlier.usage.observed')?.attributes).toContainEqual({
    key: 'vinaya.earlier.units',
    value: {
      kvlistValue: {
        values: [
          { key: 'input', value: { intValue: '100' } },
          { key: 'output', value: { intValue: '50' } },
          { key: 'cache', value: {} }
        ]
      }
    }
  })
  expect(logs.some((event) => event.eventName === E.agentStarted)).toBe(false)
  expect(JSON.stringify(convertEarlierEvents(fixtures))).toBe(JSON.stringify(convertEarlierEvents(fixtures)))
})

test('an earlier pause and its resume become one vinaya.pause span', () => {
  const pause = fixtures.find((e) => e.event === 'paused')!
  const resume = fixtures.find((e) => e.event === 'resumed')!
  const { spans, logs } = records([pause, resume])
  expect(spans.map((s) => s.name)).toEqual([S.pause])
  expect(logs).toEqual([])
  const get = (key: string) => spans[0]?.attributes.find((a) => a.key === key)?.value
  expect(get(A.roundNumber)).toEqual({ intValue: '1' })
  expect(get(A.pauseWhy)).toEqual({ stringValue: 'escalation' })
  expect(get(A.pauseBy)).toEqual({ stringValue: 'person' })
  expect(spans[0]?.events?.[0]?.name).toBe(E.pauseStarted)
})

test('each earlier forge write is the forge event the handle writes for what happened', () => {
  const names = fixtures
    .filter((e) => e.kind === 'forge_write')
    .map((e) => `${e.event}:${records([e]).logs[0]?.eventName}`)
  expect(names.sort()).toEqual([
    `refused:${E.forgeRefused}`,
    `validated:${E.forgeValidated}`,
    `written:${E.forgeWritten}`
  ])
})

test('every converted name and attribute is one the handle writes', () => {
  const { spans, logs } = records(fixtures)
  for (const span of spans) {
    expect(isSpanName(span.name), span.name).toBe(true)
  }
  for (const log of logs) {
    const own = log.eventName.startsWith(EARLIER_EVENT_PREFIX) || log.eventName === 'team.shipped'
    expect(own || ALL_EVENT_NAMES.includes(log.eventName), log.eventName).toBe(true)
  }
  const catalogued = (key: string) => key.startsWith(EARLIER_EVENT_PREFIX) || ALL_ATTRIBUTE_NAMES.includes(key)
  for (const record of [...spans, ...logs]) {
    if ('eventName' in record && record.eventName === 'team.shipped') continue
    for (const attribute of record.attributes) expect(catalogued(attribute.key), attribute.key).toBe(true)
  }
})

test('writer stamps follow the header process id with a run id fallback', () => {
  const original = fixtures.find((event) => event.kind === 'custom')!
  const newer = (processId: string) =>
    LogEventSchema.parse({
      ...original,
      meta: {
        ...original.meta,
        schema: 2,
        event_id: `event-${processId}`,
        process_id: processId,
        actor_id: null,
        lineage: { run: 'different', attempt: null, parent: null },
        input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
        provenance: 'unavailable'
      }
    })
  const { logs } = records([original, newer('one'), newer('two')])
  expect(logs.map((log) => log.attributes.find((attribute) => attribute.key === A.writerId)?.value)).toEqual([
    { stringValue: 'earlier:run-historical' },
    { stringValue: 'earlier:one' },
    { stringValue: 'earlier:two' }
  ])
  expect(logs.map((log) => log.traceId)).toEqual(Array(3).fill(traceIdFor(original.meta.run_id)))
})
