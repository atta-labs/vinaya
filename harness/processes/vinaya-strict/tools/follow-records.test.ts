import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../../../../packages/log-sdk/src/contract/catalogue.js'
import { spanIdFor } from '../../../../packages/log-sdk/src/contract/ids.js'
import type { OtelRecord } from '../../../../packages/log-sdk/src/reader/records.js'
import { registerVinayaLogRoles } from '../integration/log/log-roles.js'
import { createRecordFollow } from './follow-records.js'

const now = new Date('2026-11-19T10:00:00Z')
const epoch = BigInt(now.getTime()) * 1_000_000n
const nanos = (ms: number) => String(epoch + BigInt(ms) * 1_000_000n)
const record = (
  name: string,
  ms: number,
  attributes: OtelRecord['attributes'],
  kind: OtelRecord['kind'] = 'event',
  spanId = 'span'
): OtelRecord => ({
  kind,
  name,
  time: nanos(ms),
  startTime: kind === 'span' ? nanos(1000) : null,
  attributes,
  traceId: 'run',
  spanId,
  parentSpanId: null,
  resource: {},
  seq: null,
  writerId: null,
  eventId: null,
  source: 'fixture',
  provenance: 'governed'
})
const step = (call: string, target: string) => ({
  [A.toolCallId]: call,
  [A.stepKind]: 'reading',
  [A.stepTarget]: target,
  [A.seat]: 'developer'
})
function view(details: boolean, colour = false) {
  registerVinayaLogRoles()
  return createRecordFollow({
    details,
    colour,
    timeZone: 'UTC',
    history: { develop: { medianMinutes: 8, samples: 3 } }
  })
}

test('a stage uses the shared banner and clock, and loop records use SDK narration', () => {
  const follow = view(false)
  expect(
    follow.render(
      {
        records: [
          record(E.runStarted, 0, {}),
          record(E.roundStarted, 0, { [A.roundNumber]: 1 }),
          record(E.stageChanged, 0, { [A.roundNumber]: 1, [A.stageTo]: 'develop' })
        ],
        gaps: []
      },
      [],
      now,
      true
    )
  ).toEqual(['10:00:00  ◆ Loop   Round 1 started.', '10:00:00  ◆ Loop   ━━ Round 1 · develop · typical 8m ━━'])
  expect(follow.tick(new Date(now.getTime() + 300_000))).toEqual([
    '10:05:00  ◌ Loop   Still in develop (round 1) after 5m'
  ])
})

test('backlog pairs each action with its own finish and attaches both exact and seat-only details', () => {
  const records = [
    record(E.stepStarted, 1000, step('a', 'first'), 'started', 'a'),
    record(E.stepStarted, 2000, step('b', 'second'), 'started', 'b'),
    record('execute_tool Read', 3000, step('a', 'first'), 'span', 'a')
  ]
  const driver = [
    '2026-11-19T10:00:01Z [call=a]  > Developer   Driver narration is ignored',
    '2026-11-19T10:00:01Z [command]  · full command',
    '2026-11-19T10:00:02Z  > Developer   Writing',
    '2026-11-19T10:00:02Z  · developer note'
  ]
  const follow = view(true, true)
  expect(follow.render({ records, gaps: [] }, driver, now, true)).toEqual([
    '\x1b[36m10:00:01  ✓ Developer   Finished reading first in 2.0s\x1b[0m',
    '\x1b[2m\x1b[36m          · full command\x1b[0m',
    '\x1b[36m10:00:02  ▸ Developer   Reading second\x1b[0m',
    '\x1b[2m\x1b[36m          · developer note\x1b[0m'
  ])
  expect(view(false).render({ records, gaps: [] }, driver, now, true)).toHaveLength(2)
})

test('live finish names its start time and a gap gets its own line', () => {
  const follow = view(false)
  expect(
    follow.render(
      {
        records: [record(E.stepStarted, 1000, step('a', 'first'), 'started')],
        gaps: [{ kind: 'sequence', writerId: 'writer', place: 'sequence 2', detail: 'sequence 2 never arrived' }]
      },
      [],
      now,
      false
    )
  ).toEqual([
    '10:00:00  ▸ Loop   Log gap (sequence) at sequence 2: sequence 2 never arrived',
    '10:00:01  ▸ Developer   Reading first'
  ])
  expect(
    follow.render(
      {
        records: [record('execute_tool Read', 3000, step('a', 'first'), 'span')],
        gaps: []
      },
      [],
      now,
      false
    )
  ).toEqual(['10:00:03  ✓ Developer   Finished reading first in 2.0s (started 10:00:01)'])
})

test('a recorded step inherits its seat from the dispatch even without a seat stamp', () => {
  const follow = view(true, true)
  const spanId = spanIdFor('run', 'step:effect:call')
  const records = [
    record(E.agentStarted, 0, { [A.agentId]: 'effect', [A.agentName]: 'code-reviewer' }),
    record(
      E.stepStarted,
      1000,
      {
        [A.runId]: 'run',
        [A.toolCallId]: 'call',
        [A.stepKind]: 'reading',
        [A.stepTarget]: 'file'
      },
      'started',
      spanId
    )
  ]
  const lines = follow.render({ records, gaps: [] }, [], now, false)
  expect(lines[0]).toContain('code reviewer')
  expect(lines[1]).toBe('\x1b[35m10:00:01  ▸ Code review   Reading file\x1b[0m')
  const finish = record(
    'execute_tool Read',
    3000,
    {
      [A.toolCallId]: 'call',
      [A.stepKind]: 'reading',
      [A.stepTarget]: 'file'
    },
    'span',
    spanId
  )
  expect(follow.render({ records: [finish], gaps: [] }, [], now, false)).toEqual([
    '\x1b[35m10:00:03  ✓ Code review   Finished reading file in 2.0s (started 10:00:01)\x1b[0m'
  ])
})

test('an early detail waits for its call and a late detail identifies its step', () => {
  const follow = view(true)
  const a = record(E.stepStarted, 1000, step('a', 'first'), 'started', 'a')
  const b = record(E.stepStarted, 2000, step('b', 'second\n\r'), 'started', 'b')
  expect(
    follow.render(
      { records: [a], gaps: [] },
      ['2026-11-19T10:00:02Z [call=b]  > Developer   Reading', '2026-11-19T10:00:02Z  · details for b'],
      now,
      false
    )
  ).toEqual(['10:00:01  ▸ Developer   Reading first'])
  expect(follow.render({ records: [b], gaps: [] }, [], now, false)).toEqual([
    '10:00:02  ▸ Developer   Reading second\\u000a\\u000d',
    '          · details for b'
  ])
  expect(
    follow.render(
      { records: [], gaps: [] },
      ['2026-11-19T10:00:01Z [call=a]  > Developer   Reading', '2026-11-19T10:00:03Z  · late detail'],
      now,
      false
    )
  ).toEqual(['          · Developer a: late detail'])
  expect(
    follow.render(
      { records: [], gaps: [] },
      ['2026-11-19T10:00:03Z [call=missing]  > Developer   Reading', '2026-11-19T10:00:03Z  · unmatched note'],
      now,
      false
    )
  ).toEqual([])
  expect(follow.render({ records: [], gaps: [] }, [], now, false)).toEqual(['          · Developer b: unmatched note'])
})

test('an exit from an older run leaves the active run’s stage timer intact', () => {
  const follow = view(false)
  const attributes = { [A.roundNumber]: 1, [A.stageTo]: 'develop' }
  follow.render(
    {
      records: [
        { ...record(E.stageChanged, 0, attributes), traceId: 'old' },
        record(E.stageChanged, 1000, attributes),
        { ...record(E.exited, 2000, { [A.exitKind]: 'finished' }), traceId: 'old' }
      ],
      gaps: []
    },
    [],
    now,
    true
  )
  expect(follow.tick(new Date(now.getTime() + 301_000))).toEqual([
    '10:05:01  ◌ Loop   Still in develop (round 1) after 5m'
  ])
})

test('action starts omit suffixes when the record has no counts or confidence', () => {
  const records = ['editing', 'creating', 'reporting'].map((kind, i) =>
    record(
      E.stepStarted,
      1000 + i * 1000,
      {
        ...step(kind, 'file'),
        [A.stepKind]: kind
      },
      'started',
      kind
    )
  )
  expect(view(false).render({ records, gaps: [] }, [], now, false)).toEqual([
    '10:00:01  ▸ Developer   Editing file',
    '10:00:02  ▸ Developer   Creating file',
    '10:00:03  ▸ Developer   Reporting file'
  ])
})

test('a reported record is marked as reported and never draws a banner or loop narration', () => {
  const reported = { [A.provenance]: 'reported', [A.stageTo]: 'review', [A.roundNumber]: 1 }
  const lines = view(false).render(
    {
      records: [
        record(E.stageChanged, 1000, reported),
        record(E.runStarted, 2000, { [A.provenance]: 'reported' }),
        record(E.stageChanged, 3000, { [A.stageTo]: 'develop', [A.roundNumber]: 1 })
      ],
      gaps: []
    },
    [],
    now,
    false
  )
  expect(lines).toEqual([
    '10:00:01  ▸ Reported   vinaya.run.stage_changed (reported, not governed)',
    '10:00:02  ▸ Reported   vinaya.run.started (reported, not governed)',
    '10:00:03  ◆ Loop   ━━ Round 1 · develop · typical 8m ━━'
  ])
})

test('records at or before the driver-log time already printed are not printed again', () => {
  const records = [
    record(E.stepStarted, 1000, step('a', 'first'), 'started', 'a'),
    record(E.stepStarted, 2000, step('b', 'second'), 'started', 'b')
  ]
  const through = now.getTime() + 1000
  expect(view(false).render({ records, gaps: [] }, [], now, true, through)).toEqual([
    '10:00:02  ▸ Developer   Reading second'
  ])
})
