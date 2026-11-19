import { expect, test } from 'bun:test'
import {
  ATTRIBUTE_NAMES as A,
  EVENT_NAMES as E,
  narrate,
  NARRATION_KINDS,
  type OtelRecord,
  reasonWaitsOn,
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

const names: SeatNames = {
  developer: 'developer',
  'code-reviewer': { reading: 'code reviewer', reviews: true }
}

test('a round starts, its checks pass or fail, and its verdicts read through the seat names', () => {
  expect(narrate(record(E.roundStarted, { [A.roundNumber]: 2 }), names)).toEqual({
    kind: 'starting',
    text: 'Round 2 started.'
  })
  expect(narrate(record(E.checkRead, { [A.roundNumber]: 2, [A.checksGreen]: true }), names)).toEqual({
    kind: 'done',
    text: 'Round 2: the checks passed.'
  })
  expect(narrate(record(E.checkRead, { [A.roundNumber]: 2, [A.checksGreen]: false }), names)?.kind).toBe('failed')
  const verdicts = record(E.reviewVerdicts, {
    [A.roundNumber]: 2,
    [A.seats]: ['code-reviewer', 'unknown-seat'],
    [A.verdicts]: ['approve', 'not_reviewed'],
    [A.blockingCount]: 0
  })
  expect(narrate(verdicts, names)).toEqual({
    kind: 'information',
    text: 'Round 2 verdicts: The code reviewer approved; a role did not review.'
  })
})

test('seats read as recorded without seat names and by their reading names with them', () => {
  const started = record(E.agentStarted, { [A.agentName]: 'code-reviewer', [A.roundNumber]: 3 })
  expect(narrate(started)).toEqual({ kind: 'working', text: 'Code-reviewer is working on round 3.' })
  expect(narrate(started, names)).toEqual({ kind: 'working', text: 'The code reviewer is reviewing round 3.' })
  expect(narrate(started, {})).toEqual({ kind: 'working', text: 'A role is working on round 3.' })
  const turn = record(
    `${S.agent} developer`,
    { [A.agentName]: 'developer', [A.agentOutcome]: 'completed' },
    {
      kind: 'span',
      startTime: '1'
    }
  )
  expect(narrate(turn, names)).toEqual({ kind: 'done', text: 'The developer finished its turn.' })
  expect(narrate(turn)).toEqual({ kind: 'done', text: 'Developer finished its turn.' })
  const failed = record(
    `${S.agent} developer`,
    { [A.agentName]: 'developer', [A.errorType]: 'timeout' },
    { kind: 'span' }
  )
  expect(narrate(failed, names)).toBeNull()
})

test('pauses and stops read from the reason table, and a round end carries the confidence clause', () => {
  expect(narrate(record(E.pauseStarted, { [A.pauseWhy]: 'max_rounds' }))).toEqual({
    kind: 'blocked',
    text: 'The loop paused for a person: the round limit was reached.'
  })
  expect(narrate(record(E.pauseStarted, { [A.pauseWhy]: 'principal_item' }))?.text).toBe(
    'The loop paused for a person: an item needs a person to decide.'
  )
  expect(narrate(record(E.pauseStarted, { [A.pauseWhy]: 'odd_reason' }))?.text).toBe('Paused: odd_reason.')
  expect(narrate(record(E.stopRuleMet, { [A.rule]: 'approved' }))?.text).toBe(
    'The loop stopped: every check and review passed.'
  )
  expect(narrate(record(E.stopRuleMet, { [A.rule]: 'round_limit' }))).toEqual({
    kind: 'blocked',
    text: 'The loop stopped itself: the round limit was reached. A person has to act.'
  })
  expect(reasonWaitsOn('max_rounds')).toBe('person')
  expect(reasonWaitsOn('ruling_posted')).toBe('loop')
  expect(reasonWaitsOn('nothing')).toBeNull()

  const end = record(
    `${S.round} 2`,
    { [A.roundNumber]: 2, [A.roundOutcome]: 'green' },
    {
      kind: 'span',
      startTime: '1000000000',
      time: '91000000000'
    }
  )
  expect(narrate(end)).toEqual({ kind: 'done', text: 'Round 2 ended after 1m 30s: approved.' })
  const stated = record(E.confidenceStated, { [A.roundNumber]: 2, [A.confidence]: 85 })
  expect(narrate(end, undefined, [stated])?.text).toBe('Round 2 ended after 1m 30s: approved. Confidence: 85.')
})

test("the driver's exit and a conflict re-entry read in plain words", () => {
  expect(narrate(record(E.exited, { [A.exitKind]: 'restarted' }))?.text).toBe(
    'The driver restarted itself on updated code.'
  )
  expect(narrate(record(E.exited, { [A.exitKind]: 'error', [A.exitCode]: 2, [A.errorType]: 'crash' }))).toEqual({
    kind: 'failed',
    text: 'The driver stopped on an error (crash) (exit code 2).'
  })
  expect(narrate(record(E.changeConflicted, { [A.change]: '42' }))?.text).toContain(
    'Pull request #42 fell into conflict'
  )
})

test('a record with no wording gives null and a value that is no record never throws', () => {
  expect(narrate(record('vinaya.something.else', {}))).toBeNull()
  for (const value of [
    null,
    undefined,
    3,
    'text',
    [],
    {},
    { name: 1 },
    { name: 'x', kind: 'event', attributes: null }
  ]) {
    expect(narrate(value, names)).toBeNull()
  }
  expect(narrate(record(E.roundStarted, { [A.roundNumber]: 1 }), null as never, null as never)?.kind).toBe('starting')
  expect(NARRATION_KINDS).toContain('blocked')
})
