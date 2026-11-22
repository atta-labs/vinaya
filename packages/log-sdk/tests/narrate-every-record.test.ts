import { expect, test } from 'bun:test'
import {
  ATTRIBUTE_NAMES as A,
  EVENT_NAMES as E,
  narrate,
  type NarrationKind,
  type OtelRecord,
  type SeatNames,
  SPAN_NAMES as S
} from '../src/index.js'

function record(name: string, attributes: OtelRecord['attributes'], overrides: Partial<OtelRecord> = {}): OtelRecord {
  return {
    kind: 'event',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name,
    startTime: null,
    time: '2000000000',
    attributes,
    resource: {},
    seq: null,
    writerId: null,
    eventId: null,
    provenance: 'governed',
    source: 's',
    ...overrides
  }
}

const end = (name: string, attributes: OtelRecord['attributes']): OtelRecord =>
  record(name, attributes, { kind: 'span', startTime: '1' })

const names: SeatNames = { 'qa-agent': 'QA agent', reviewer: { reading: 'reviewer', reviews: true } }

type Case = { type: string; record: OtelRecord; kind: NarrationKind }

const cases: Case[] = [
  // The eight span ends, each with and without its filled-in part.
  ...[
    [S.run, { [A.runOutcome]: 'ready' }, 'done'],
    [S.round, { [A.roundNumber]: 1, [A.roundOutcome]: 'green' }, 'done'],
    [S.phase, { [A.phaseName]: 'review' }, 'done'],
    [S.agent, { [A.agentName]: 'reviewer', [A.errorType]: 'timeout' }, 'failed'],
    [S.step, {}, 'done'],
    [S.checks, { [A.checkWhere]: 'ci', [A.result]: 'green' }, 'done'],
    [S.person, { [A.personAnswer]: 'ruling_given' }, 'information'],
    [S.pause, {}, 'information']
  ].flatMap(([base, attributes, kind]) => [
    {
      type: String(base),
      record: end(String(base), attributes as OtelRecord['attributes']),
      kind: kind as NarrationKind
    },
    {
      type: `${String(base)} <part>`,
      record: end(`${String(base)} part`, attributes as OtelRecord['attributes']),
      kind: kind as NarrationKind
    }
  ]),
  { type: S.run, record: end(S.run, { [A.runOutcome]: 'stopped' }), kind: 'information' },
  { type: S.phase, record: end(S.phase, { [A.errorType]: 'boom' }), kind: 'failed' },
  { type: S.step, record: end(S.step, { [A.errorType]: 'boom' }), kind: 'failed' },
  { type: S.checks, record: end(S.checks, { [A.result]: 'red' }), kind: 'failed' },
  { type: S.checks, record: end(S.checks, { [A.result]: 'pending' }), kind: 'waiting' },
  { type: E.runStarted, record: record(E.runStarted, {}), kind: 'starting' },
  { type: E.roundStarted, record: record(E.roundStarted, { [A.roundNumber]: 2 }), kind: 'starting' },
  { type: E.agentStarted, record: record(E.agentStarted, { [A.agentName]: 'reviewer' }), kind: 'working' },
  { type: E.usageRecorded, record: record(E.usageRecorded, { [A.usageInputTokens]: 5 }), kind: 'information' },
  { type: E.stepStarted, record: record(E.stepStarted, { [A.stepKind]: 'reading' }), kind: 'working' },
  { type: E.pauseStarted, record: record(E.pauseStarted, { [A.pauseWhy]: 'max_rounds' }), kind: 'blocked' },
  { type: E.personAsked, record: record(E.personAsked, { [A.personDecision]: 'ruling' }), kind: 'waiting' },
  { type: E.alive, record: record(E.alive, { [A.roundNumber]: 1 }), kind: 'working' },
  { type: E.stageChanged, record: record(E.stageChanged, { [A.stageTo]: 'review' }), kind: 'information' },
  {
    type: `${E.stageChanged} (paused)`,
    record: record(E.stageChanged, { [A.stageTo]: 'paused_principal' }),
    kind: 'waiting'
  },
  { type: E.cancelled, record: record(E.cancelled, {}), kind: 'information' },
  { type: E.retried, record: record(E.retried, { [A.retryRecovered]: true }), kind: 'information' },
  {
    type: `${E.retried} (not recovered)`,
    record: record(E.retried, { [A.retryRecovered]: false }),
    kind: 'failed'
  },
  { type: E.stopRuleMet, record: record(E.stopRuleMet, { [A.rule]: 'approved' }), kind: 'done' },
  { type: E.exited, record: record(E.exited, { [A.exitKind]: 'finished' }), kind: 'done' },
  { type: E.confidenceStated, record: record(E.confidenceStated, { [A.confidence]: 80 }), kind: 'information' },
  {
    type: E.reviewVerdicts,
    record: record(E.reviewVerdicts, { [A.seats]: ['reviewer'], [A.verdicts]: ['approve'], [A.blockingCount]: 0 }),
    kind: 'done'
  },
  { type: E.findingsCompared, record: record(E.findingsCompared, {}), kind: 'information' },
  { type: E.checkNotPassed, record: record(E.checkNotPassed, { [A.checkName]: 'lint' }), kind: 'failed' },
  { type: E.checkRead, record: record(E.checkRead, { [A.checksGreen]: true }), kind: 'done' },
  { type: E.forgeValidated, record: record(E.forgeValidated, { [A.action]: 'comment' }), kind: 'information' },
  { type: E.forgeRefused, record: record(E.forgeRefused, { [A.action]: 'comment' }), kind: 'blocked' },
  { type: E.forgeWritten, record: record(E.forgeWritten, { [A.action]: 'comment' }), kind: 'done' },
  { type: E.actionVerified, record: record(E.actionVerified, { [A.result]: 'success' }), kind: 'done' },
  {
    type: `${E.actionVerified} (failure)`,
    record: record(E.actionVerified, { [A.result]: 'failure' }),
    kind: 'failed'
  },
  {
    type: `${E.actionVerified} (uncertain)`,
    record: record(E.actionVerified, { [A.result]: 'uncertain' }),
    kind: 'information'
  },
  { type: E.commandCompleted, record: record(E.commandCompleted, { [A.result]: 'ok' }), kind: 'done' },
  {
    type: `${E.commandCompleted} (timeout)`,
    record: record(E.commandCompleted, { [A.result]: 'timeout' }),
    kind: 'failed'
  },
  {
    type: `${E.commandCompleted} (cancelled)`,
    record: record(E.commandCompleted, { [A.result]: 'cancelled' }),
    kind: 'information'
  },
  { type: E.changeSaved, record: record(E.changeSaved, {}), kind: 'information' },
  { type: E.changePushed, record: record(E.changePushed, { [A.result]: 'passed' }), kind: 'done' },
  { type: `${E.changePushed} (refused)`, record: record(E.changePushed, { [A.result]: 'refused' }), kind: 'failed' },
  { type: E.changeOpened, record: record(E.changeOpened, { [A.change]: '318' }), kind: 'done' },
  { type: E.changeConflicted, record: record(E.changeConflicted, { [A.change]: '318' }), kind: 'working' },
  { type: E.changeRecovered, record: record(E.changeRecovered, {}), kind: 'information' },
  { type: E.changeMerged, record: record(E.changeMerged, { [A.workChange]: '318' }), kind: 'done' },
  { type: E.changeClosed, record: record(E.changeClosed, { [A.workChange]: '318' }), kind: 'information' },
  { type: E.changeReverted, record: record(E.changeReverted, { [A.workChange]: '318' }), kind: 'information' },
  { type: E.changeIncident, record: record(E.changeIncident, { [A.workChange]: '318' }), kind: 'failed' },
  { type: 'a declared custom event', record: record('acme.deployed', { region: 'eu' }), kind: 'information' }
]

test('every record type the Log SDK writes gives one line of its assigned kind', () => {
  const covered = new Set(cases.map((c) => c.type.split(' ')[0]))
  for (const name of [...Object.values(S), ...Object.values(E)]) {
    expect(covered.has(name), `no case for record type ${name}`).toBe(true)
  }
  for (const c of cases) {
    const line = narrate(c.record, names)
    expect(line, `record type ${c.type} has no line`).not.toBeNull()
    expect(line?.kind, `record type ${c.type}`).toBe(c.kind)
    expect(line?.text.length, `record type ${c.type}`).toBeGreaterThan(0)
  }
})

test('the six examples of the narration section read word for word', () => {
  expect(narrate(record(E.roundStarted, { [A.roundNumber]: 2 }), names)?.text).toBe('Round 2 started.')

  const agent = record(E.agentStarted, { [A.agentName]: 'qa-agent' }, { spanId: 'c'.repeat(16) })
  const step = record(
    E.stepStarted,
    { [A.stepKind]: 'editing', [A.stepTarget]: 'src/export.ts' },
    { parentSpanId: 'c'.repeat(16) }
  )
  expect(narrate(step, names, [agent])).toEqual({ kind: 'working', text: 'The QA agent is editing src/export.ts.' })
  expect(narrate(step, names, [])?.text).toBe('A role is editing src/export.ts.')

  const verdicts = record(E.reviewVerdicts, {
    [A.seats]: ['reviewer'],
    [A.verdicts]: ['changes_requested'],
    [A.blockingCount]: 2
  })
  expect(narrate(verdicts, names)?.text).toContain('The reviewer asked for changes (2 blocking)')

  expect(narrate(record(E.personAsked, { [A.personDecision]: 'ruling' }))).toEqual({
    kind: 'waiting',
    text: 'Waiting for a person: a ruling is owed.'
  })
  expect(narrate(record(E.changeOpened, { [A.change]: '318' }))?.text).toBe('Ready: pull request 318.')
  expect(narrate(record(E.changeReverted, { [A.workChange]: '318' }))?.text).toBe('Pull request 318 was reverted.')
  expect(narrate(record(E.changeClosed, { [A.workChange]: '318' }))?.text).toBe(
    'Pull request 318 was closed without merging.'
  )
})

test('a code the wording does not know reads as its code', () => {
  expect(narrate(record(E.pauseStarted, { [A.pauseWhy]: 'odd_why' }))?.text).toBe('Paused: odd_why.')
  expect(narrate(record(E.stopRuleMet, { [A.rule]: 'odd_rule' }))?.text).toBe('Stopped: odd_rule.')
  expect(narrate(record(E.personAsked, { [A.personDecision]: 'odd_decision' }))?.text).toBe(
    'Waiting for a person: odd_decision.'
  )
  expect(narrate(record(E.exited, { [A.exitKind]: 'odd_kind' }))?.text).toContain('odd_kind')
  expect(narrate(record(E.commandCompleted, { [A.result]: 'odd_result', [A.action]: 'x' }))?.text).toContain(
    'odd_result'
  )
  expect(narrate(record(E.stageChanged, { [A.stageTo]: 'odd_stage' }))?.text).toContain('odd_stage')
})

test('a record with no name, an unknown name or a malformed shape gives no line and never throws', () => {
  expect(narrate(record('', {}))).toBeNull()
  expect(narrate(record('vinaya.unknown.thing', {}))).toBeNull()
  expect(narrate(record('Not A Name', {}))).toBeNull()
  expect(narrate(null)).toBeNull()
  expect(narrate({ name: 'vinaya.change.opened' })).toBeNull()
  expect(narrate(record(E.stepStarted, {}), names, [null, 3, 'x'])).not.toBeNull()
})
