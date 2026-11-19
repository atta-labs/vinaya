import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_ATTRIBUTE_NAMES, ALL_EVENT_NAMES, isSpanName } from '../src/contract/catalogue.js'
import { traceIdFor } from '../src/contract/ids.js'
import { harness } from './helpers.js'

const temp = mkdtempSync(join(tmpdir(), 'log-sdk-product-table-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

type Handle = ReturnType<typeof harness>['handle']

/** One row of the product table: the function, the record it writes and every field it lists. */
type Row = {
  row: string
  /** The span's full name, or the event's name; exactly one. */
  span?: string
  event?: string
  fields: string[]
  setup?: (h: Handle) => void
  call: (h: Handle) => void
  /** Ends a span the call started. */
  finish?: (h: Handle) => void
}

const start = new Date(1_000)
let question: { traceId: string; spanId: string } | undefined
let step: { traceId: string; spanId: string } | undefined
const run = (h: Handle) => void h.run.started({ process: 'acme' })
const inRound = (h: Handle) => {
  run(h)
  h.round.started({ number: 3 })
}
const inAgent = (h: Handle) => {
  inRound(h)
  h.agent.sent({ seat: 'reviewer' })
}
const endRun = (h: Handle) => h.run.ended()
const endRound = (h: Handle) => {
  h.round.ended()
  h.run.ended()
}
const endAgent = (h: Handle) => {
  h.agent.returned()
  endRound(h)
}

const ROWS: Row[] = [
  {
    row: 'log.run.started',
    span: 'invoke_workflow acme',
    fields: [
      'vinaya.work.ref',
      'vinaya.work.title',
      'vinaya.process.name',
      'vinaya.process.version',
      'vinaya.run.round_limit',
      'vinaya.run.seats',
      'vinaya.run.seat_models'
    ],
    call: (h) =>
      void h.run.started({
        process: 'acme',
        processVersion: '1.2.3',
        work: { ref: '42', title: 'Fix the thing' },
        roundLimit: 3,
        seats: [{ seat: 'developer', model: 'm-1' }, { seat: 'reviewer' }]
      }),
    finish: endRun
  },
  {
    row: 'log.run.ended',
    span: 'invoke_workflow acme',
    fields: [
      'vinaya.run.rounds',
      'vinaya.run.total_ms',
      'vinaya.run.time_to_green_ms',
      'vinaya.run.files_changed',
      'vinaya.run.outcome'
    ],
    setup: run,
    call: (h) => h.run.ended({ rounds: 2, totalMs: 9000, timeToGreenMs: 8000, filesChanged: 4, outcome: 'ready' })
  },
  {
    row: 'log.run.alive',
    event: 'vinaya.run.alive',
    fields: ['vinaya.round.number', 'vinaya.phase.name'],
    setup: (h) => {
      inRound(h)
      h.run.stageChanged({ to: 'review' })
    },
    call: (h) => h.run.alive()
  },
  {
    row: 'log.run.stageChanged',
    event: 'vinaya.run.stage_changed',
    fields: ['vinaya.stage.to'],
    setup: run,
    call: (h) => h.run.stageChanged({ from: 'develop', to: 'local_checks' })
  },
  {
    row: 'log.run.paused',
    span: 'vinaya.pause',
    fields: ['vinaya.round.number', 'vinaya.pause.why'],
    setup: run,
    call: (h) => void h.run.paused({ round: 2, why: 'escalation', startTime: start }),
    finish: (h) => h.run.resumed({ by: 'person' })
  },
  {
    row: 'log.run.resumed',
    span: 'vinaya.pause',
    fields: ['vinaya.pause.by'],
    setup: (h) => {
      run(h)
      h.run.paused({ round: 2, why: 'escalation', startTime: start })
    },
    call: (h) => h.run.resumed({ by: 'run' })
  },
  {
    row: 'log.run.cancelled',
    event: 'vinaya.run.cancelled',
    fields: ['vinaya.round.number', 'vinaya.actor'],
    setup: run,
    call: (h) => h.run.cancelled({ round: 2, by: 'person' })
  },
  {
    row: 'log.run.retried',
    event: 'vinaya.run.retried',
    fields: ['vinaya.retry.failed', 'vinaya.retry.tries', 'vinaya.retry.recovered'],
    setup: run,
    call: (h) => h.run.retried({ failed: 'developer_connection', tries: 2, recovered: true })
  },
  {
    row: 'log.run.stopRuleMet',
    event: 'vinaya.run.stop_rule_met',
    fields: ['vinaya.rule'],
    setup: run,
    call: (h) => h.run.stopRuleMet({ rule: 'round_limit' })
  },
  {
    row: 'log.run.exited',
    event: 'vinaya.run.exited',
    fields: ['vinaya.exit.kind', 'vinaya.exit.code', 'error.type'],
    setup: run,
    call: (h) => h.run.exited({ kind: 'error', code: 1, errorType: 'TypeError' })
  },
  {
    row: 'log.round.started',
    span: 'vinaya.round 3',
    fields: ['vinaya.round.number', 'vinaya.round.start_commit'],
    setup: run,
    call: (h) => void h.round.started({ number: 3, startingCommit: 'abc123' }),
    finish: endRound
  },
  {
    row: 'log.round.ended',
    span: 'vinaya.round 3',
    fields: [
      'vinaya.round.files_changed',
      'vinaya.round.lines_added',
      'vinaya.round.lines_removed',
      'vinaya.round.outcome'
    ],
    setup: inRound,
    call: (h) => h.round.ended({ filesChanged: 3, linesAdded: 10, linesRemoved: 4, outcome: 'green' }),
    finish: endRun
  },
  {
    row: 'log.phase.ended',
    span: 'vinaya.phase review',
    fields: ['vinaya.phase.name', 'vinaya.phase.step'],
    setup: inRound,
    call: (h) => h.phase.ended({ phase: 'review', step: 'both reviewers' })
  },
  {
    row: 'log.agent.sent',
    span: 'invoke_agent reviewer',
    fields: [
      'gen_ai.agent.name',
      'gen_ai.provider.name',
      'gen_ai.request.model',
      'vinaya.agent.coding_agent',
      'vinaya.agent.coding_agent_version',
      'vinaya.round.number'
    ],
    setup: inRound,
    call: (h) =>
      void h.agent.sent({
        seat: 'reviewer',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        codingAgent: 'claude-code',
        codingAgentVersion: '2.1.0'
      }),
    finish: endAgent
  },
  {
    row: 'log.agent.stepStarted',
    span: 'execute_tool Bash',
    fields: ['gen_ai.tool.name', 'gen_ai.tool.call.id', 'vinaya.step.kind', 'vinaya.step.target'],
    setup: inAgent,
    call: (h) => {
      step = h.agent.stepStarted({ tool: 'Bash', callId: 'call-1', kind: 'running tests', target: 'bun test' })
    },
    finish: (h) => {
      if (step !== undefined) h.agent.stepEnded(step)
      endAgent(h)
    }
  },
  {
    row: 'log.agent.stepEnded',
    span: 'execute_tool Bash',
    fields: ['error.type', 'vinaya.step.error_line'],
    setup: inAgent,
    call: (h) => {
      const running = h.agent.stepStarted({ tool: 'Bash' })
      h.agent.stepEnded(running, { errorType: 'exit_1', errorLine: 'boom' })
    },
    finish: endAgent
  },
  {
    row: 'log.agent.returned',
    span: 'invoke_agent reviewer',
    fields: ['vinaya.agent.outcome', 'vinaya.attempt', 'gen_ai.response.model'],
    setup: inAgent,
    call: (h) => h.agent.returned({ outcome: 'verdict', attempt: 2, responseModel: 'claude-opus-5-5-20261101' }),
    finish: endRound
  },
  {
    row: 'log.agent.failed',
    span: 'invoke_agent reviewer',
    fields: ['error.type', 'vinaya.agent.reset_at'],
    setup: inAgent,
    call: (h) => h.agent.failed({ errorType: 'usage_limit', resetAt: '2026-11-20T03:00:00Z' }),
    finish: endRound
  },
  {
    row: 'log.agent.confidenceStated',
    event: 'vinaya.agent.confidence_stated',
    fields: ['vinaya.confidence', 'vinaya.confidence.reason', 'vinaya.confidence.after_extra_turn'],
    setup: inAgent,
    call: (h) => h.agent.confidenceStated({ confidence: 80, reason: 'tests_green', afterExtraTurn: true }),
    finish: endAgent
  },
  {
    row: 'log.usage.recorded',
    span: 'invoke_agent reviewer',
    fields: [
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
      'gen_ai.usage.cache_read.input_tokens',
      'vinaya.usage.cost',
      'vinaya.usage.cost_kind'
    ],
    setup: inAgent,
    call: (h) =>
      h.usage.recorded({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 7,
        cost: { amount: 0.25, kind: 'estimated' }
      }),
    finish: endAgent
  },
  {
    row: 'log.review.verdicts',
    event: 'vinaya.review.verdicts',
    fields: [
      'vinaya.review.seats',
      'vinaya.review.verdicts',
      'vinaya.review.blocking_count',
      'vinaya.review.finding_ids',
      'vinaya.review.finding_severities',
      'vinaya.review.finding_places',
      'vinaya.review.finding_blocking'
    ],
    setup: inRound,
    call: (h) =>
      h.review.verdicts({
        seats: [{ seat: 'reviewer', verdict: 'changes_requested' }],
        blockingCount: 1,
        findings: [{ id: 'F1', severity: 'major', place: 'a.ts:3', blocking: true }]
      })
  },
  {
    row: 'log.review.findingsCompared',
    event: 'vinaya.review.findings_compared',
    fields: ['vinaya.review.open', 'vinaya.review.resolved', 'vinaya.review.new', 'vinaya.review.recurring'],
    setup: inRound,
    call: (h) => h.review.findingsCompared({ open: ['F1'], resolved: ['F0'], new: ['F2'], recurring: [] })
  },
  {
    row: 'log.checks.ran',
    span: 'vinaya.checks hook',
    fields: [
      'vinaya.checks.where',
      'vinaya.checks.ran',
      'vinaya.checks.passed',
      'vinaya.checks.failed',
      'vinaya.checks.skipped',
      'vinaya.checks.failed_names'
    ],
    setup: inRound,
    call: (h) => h.checks.ran({ where: 'hook', ran: 5, passed: 3, failed: 1, skipped: 1, failedNames: ['lint'] })
  },
  {
    row: 'log.checks.notPassed',
    event: 'vinaya.checks.not_passed',
    fields: ['vinaya.checks.name', 'vinaya.checks.version', 'vinaya.result', 'vinaya.reason'],
    setup: inRound,
    call: (h) => h.checks.notPassed({ name: 'lint', version: '4', result: 'failed', reason: 'format' })
  },
  {
    row: 'log.checks.read',
    event: 'vinaya.checks.read',
    fields: ['vinaya.round.number', 'vinaya.checks.green'],
    setup: inRound,
    call: (h) => h.checks.read({ round: 3, green: true })
  },
  {
    row: 'log.checks.local',
    span: 'vinaya.checks local',
    fields: ['vinaya.result'],
    setup: inRound,
    call: (h) => h.checks.local({ passed: true })
  },
  {
    row: 'log.checks.ci',
    span: 'vinaya.checks ci',
    fields: ['vinaya.result', 'vinaya.checks.failed_names', 'vinaya.checks.wait_ms'],
    setup: inRound,
    call: (h) => h.checks.ci({ result: 'red', failing: ['build'], waitMs: 1200 })
  },
  {
    row: 'log.checks.rerun',
    span: 'vinaya.checks rerun',
    fields: ['vinaya.checks.rerun_failed', 'vinaya.checks.rerun_affected', 'vinaya.checks.rerun_total'],
    setup: inRound,
    call: (h) => h.checks.rerun({ failed: 1, affected: 4, total: 200 })
  },
  {
    row: 'log.change.saved',
    event: 'vinaya.change.saved',
    fields: ['vinaya.change.branch', 'vinaya.change.commit'],
    setup: run,
    call: (h) => h.change.saved({ branch: 'task/x/1', commit: 'abc' })
  },
  {
    row: 'log.change.pushed',
    event: 'vinaya.change.pushed',
    fields: ['vinaya.result', 'vinaya.change.tests_picked', 'vinaya.change.tests_failed', 'vinaya.change.push_ms'],
    setup: run,
    call: (h) => h.change.pushed({ result: 'refused', picked: 20, failed: 1, ms: 5000 })
  },
  {
    row: 'log.change.opened',
    event: 'vinaya.change.opened',
    fields: ['vinaya.change.id', 'vinaya.change.commit'],
    setup: run,
    call: (h) => h.change.opened({ change: 'pr-7', commit: 'abc' })
  },
  {
    row: 'log.change.conflicted',
    event: 'vinaya.change.conflicted',
    fields: ['vinaya.change.reentry'],
    setup: run,
    call: (h) => h.change.conflicted({ reentry: 2 })
  },
  {
    row: 'log.change.recovered',
    event: 'vinaya.change.recovered',
    fields: [],
    setup: run,
    call: (h) => h.change.recovered()
  },
  {
    row: 'log.change.merged',
    event: 'vinaya.change.merged',
    fields: ['vinaya.actor'],
    setup: run,
    call: (h) => h.change.merged({ runId: 'run-1', when: start, by: 'person' })
  },
  {
    row: 'log.change.reverted',
    event: 'vinaya.change.reverted',
    fields: ['vinaya.reason'],
    setup: run,
    call: (h) => h.change.reverted({ runId: 'run-1', when: start, reason: 'regression' })
  },
  {
    row: 'log.change.incident',
    event: 'vinaya.change.incident',
    fields: ['vinaya.severity', 'vinaya.change.link'],
    setup: run,
    call: (h) => h.change.incident({ runId: 'run-1', severity: 'high', link: 'https://example.test/i/1' })
  },
  {
    row: 'log.person.asked',
    span: 'vinaya.person strategy',
    fields: ['vinaya.person.kind', 'vinaya.person.why', 'vinaya.person.decision'],
    setup: run,
    call: (h) => {
      question = h.person.asked({
        kind: 'strategy',
        key: 'q1',
        why: 'two_designs',
        decision: 'pick_one',
        startTime: start
      })
    },
    finish: (h) =>
      h.person.answered({ kind: 'strategy', spanId: question?.spanId ?? '', startTime: start, by: 'principal' })
  },
  {
    row: 'log.person.answered',
    span: 'vinaya.person strategy',
    fields: ['vinaya.person.answer', 'vinaya.person.answered_by'],
    setup: (h) => {
      run(h)
      question = h.person.asked({ kind: 'strategy', key: 'q1', startTime: start })
    },
    call: (h) =>
      h.person.answered({
        kind: 'strategy',
        spanId: question?.spanId ?? '',
        startTime: start,
        answer: 'option_a',
        by: 'principal'
      })
  },
  {
    row: 'log.forge.validated',
    event: 'vinaya.forge.validated',
    fields: ['vinaya.outside.action', 'vinaya.outside.target'],
    setup: run,
    call: (h) => h.forge.validated({ action: 'pr.comment', target: '12' })
  },
  {
    row: 'log.forge.refused',
    event: 'vinaya.forge.refused',
    fields: ['vinaya.outside.action', 'vinaya.outside.target', 'vinaya.reason'],
    setup: run,
    call: (h) => h.forge.refused({ action: 'pr.comment', target: '12', why: 'body_too_long' })
  },
  {
    row: 'log.forge.written',
    event: 'vinaya.forge.written',
    fields: ['vinaya.outside.action', 'vinaya.outside.target'],
    setup: run,
    call: (h) => h.forge.written({ action: 'pr.comment', target: '12' })
  },
  {
    row: 'log.action.verified',
    event: 'vinaya.action.verified',
    fields: ['vinaya.outside.action', 'vinaya.outside.target', 'vinaya.result'],
    setup: run,
    call: (h) => h.action.verified({ action: 'merge', target: '12', result: 'uncertain' })
  },
  {
    row: 'log.command.completed',
    event: 'vinaya.command.completed',
    fields: ['vinaya.outside.action', 'vinaya.outside.target', 'vinaya.result'],
    setup: run,
    call: (h) => h.command.completed({ action: 'release', target: 'cli', result: 'timeout' })
  },
  {
    row: 'log.custom.recorded',
    event: 'team.deployed',
    fields: ['count'],
    setup: run,
    call: (h) => h.custom.recorded('team.deployed', { count: 2 })
  }
]

function declared() {
  const repoRoot = mkdtempSync(join(temp, 'repo-'))
  writeFileSync(
    join(repoRoot, 'vinaya.config.json'),
    JSON.stringify({ logs: { events: { 'team.deployed': { fields: { count: 'number' } } } } })
  )
  return harness({ repoRoot, destination: { folder: join(temp, 'logs') } })
}

function resolve(h: Handle, row: string): unknown {
  let at: unknown = h
  for (const part of row.replace(/^log\./, '').split('.')) at = (at as Record<string, unknown> | undefined)?.[part]
  return at
}

for (const row of ROWS) {
  test(row.row, async () => {
    const t = declared()
    row.setup?.(t.handle)
    if (typeof resolve(t.handle, row.row) !== 'function') throw new Error(`${row.row}: the function is missing`)
    row.call(t.handle)
    row.finish?.(t.handle)
    await t.handle.flush()
    expect(t.errors, `${row.row}: the handle reported an error`).toEqual([])

    const wanted = row.span ?? row.event
    const attributes =
      row.span === undefined
        ? t.logs.getFinishedLogRecords().find((e) => e.eventName === row.event)?.attributes
        : t.spans.getFinishedSpans().find((s) => s.name === row.span)?.attributes
    if (attributes === undefined) throw new Error(`${row.row}: no record named "${wanted}" was written`)
    for (const field of row.fields) {
      if (!(field in attributes)) throw new Error(`${row.row}: "${wanted}" does not record ${field}`)
    }

    // Nothing the handle wrote is outside the catalogue.
    for (const s of t.spans.getFinishedSpans()) {
      if (!isSpanName(s.name)) throw new Error(`${row.row}: span "${s.name}" is not in the catalogue`)
      for (const k of Object.keys(s.attributes))
        if (!ALL_ATTRIBUTE_NAMES.includes(k)) throw new Error(`${row.row}: ${k}`)
    }
    for (const e of t.logs.getFinishedLogRecords()) {
      if (row.row !== 'log.custom.recorded' || e.eventName !== 'team.deployed') {
        if (!ALL_EVENT_NAMES.includes(e.eventName as string)) throw new Error(`${row.row}: event ${e.eventName}`)
        for (const k of Object.keys(e.attributes))
          if (!ALL_ATTRIBUTE_NAMES.includes(k)) throw new Error(`${row.row}: ${k}`)
      }
    }
  })
}

test('the handle has exactly the functions of the table besides its own lifecycle', () => {
  const names = ROWS.map((r) => r.row)
  expect(new Set(names).size).toBe(names.length)
  const handle = harness().handle as unknown as Record<string, unknown>
  const written = Object.entries(handle).flatMap(([subject, value]) =>
    typeof value === 'object' && value !== null
      ? Object.keys(value).map((fn) => `log.${subject}.${fn}`)
      : typeof value === 'function'
        ? [subject]
        : []
  )
  const lifecycle = ['flush', 'shutdown', 'writeSpan']
  // `settings` is the resolved configuration, not a subject.
  const subjectFns = written.filter((n) => n.startsWith('log.') && !n.startsWith('log.settings.'))
  expect(subjectFns.sort()).toEqual([...names].sort())
  expect(written.filter((n) => !n.startsWith('log.')).sort()).toEqual(lifecycle.sort())
})

test('a merged change is linked to the run trace and takes its own time', () => {
  const t = harness()
  t.handle.change.merged({ runId: 'run-9', when: start, by: 'person' })
  const [event] = t.logs.getFinishedLogRecords()
  expect(event?.spanContext?.traceId).toBe(traceIdFor('run-9'))
  expect(event?.hrTime[0]).toBe(1)
})

test('usage the agent never reported is absent, never zero', () => {
  const t = harness()
  inAgent(t.handle)
  t.handle.usage.recorded({ unknownReason: 'not_reported' })
  endAgent(t.handle)
  const attributes = t.spans.getFinishedSpans().find((s) => s.name === 'invoke_agent reviewer')?.attributes ?? {}
  expect(attributes['vinaya.usage.unknown_reason']).toBe('not_reported')
  for (const name of [
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
    'gen_ai.usage.cache_read.input_tokens',
    'vinaya.usage.cost'
  ]) {
    expect(name in attributes, name).toBe(false)
  }
})
