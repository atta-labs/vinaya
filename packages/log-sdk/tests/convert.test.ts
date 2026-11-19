import { expect, test } from 'bun:test'
import {
  agentSpanIdFor,
  ATTRIBUTE_NAMES as A,
  convertEarlierEvents,
  EVENT_NAMES as E,
  LogEventSchema,
  type LogEvent,
  SPAN_NAMES as S,
  traceIdFor
} from '../src/index.js'

const fixtures = (await Bun.file(new URL('./fixtures/earlier-events.jsonl', import.meta.url)).text())
  .trim()
  .split('\n')
  .map((line) => LogEventSchema.parse(JSON.parse(line)))

const expected: Record<string, string> = {
  'dev_review_loop.loop_started': E.runStarted,
  'dev_review_loop.round_started': E.roundStarted,
  'dev_review_loop.gate_result_read': E.checkResultRead,
  'dev_review_loop.verdicts_read': E.reviewVerdicts,
  'dev_review_loop.findings_compared': E.findingsCompared,
  'dev_review_loop.stop_condition_met': E.stopRuleMet,
  'dev_review_loop.paused': E.personAsked,
  'dev_review_loop.resumed': S.personStrategy,
  'dev_review_loop.cancelled': E.cancelled,
  'dev_review_loop.unpushed_work_resume': E.changeRecovered,
  'dev_review_loop.infrastructure_retry': E.retried,
  'dev_review_loop.driver_heartbeat': E.alive,
  'dev_review_loop.conflict_reentry': E.changeConflicted,
  'dev_review_loop.storage_push': E.changePushed,
  'dev_review_loop.local_checks_run': S.checkLocal,
  'dev_review_loop.ready_push': S.checkPush,
  'dev_review_loop.failed_tests_rerun': E.retried,
  'dev_review_loop.pr_opened': E.changeOpened,
  'dev_review_loop.ci_result_read': E.checkResultRead,
  'dev_review_loop.phase_time': S.phase,
  'dev_review_loop.driver_exited': E.exited,
  'dev_review_loop.round_ended': S.round,
  'dev_review_loop.journal_finalized': S.run,
  'dispatch.dispatched': E.agentStarted,
  'dispatch.outcome_received': S.agent,
  'dispatch.dispatch_failed': S.agent,
  'role_attempt.attempted': S.agent,
  'usage.observed': 'vinaya.earlier.usage.observed',
  'forge_write.validated': E.forgeAction,
  'forge_write.refused': E.forgeAction,
  'forge_write.written': E.forgeAction,
  'gate.checked': E.checkNotPassed,
  'gate.summary': S.checkLocal,
  'operation.completed': E.commandCompleted,
  'handoff.raised': E.personAsked,
  'handoff.resolved': S.personStrategy,
  'effect.attempted': E.verifiedAction,
  'effect.observed': E.verifiedAction,
  'effect.verified': E.verifiedAction,
  'custom.recorded': 'team.shipped'
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
    const name = expected[pair]
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
  const run = spans.find((span) => span.name === S.run)
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
