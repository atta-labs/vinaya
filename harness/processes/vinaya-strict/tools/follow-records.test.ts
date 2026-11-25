import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, type OtelRecord, spanIdFor } from '@attalabs/vinaya-log-sdk'
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

const progressDriver = [
  '2026-11-19T10:00:01Z  push progress: check lint ✓, 1.0 s',
  '2026-11-19T10:00:02Z  test progress: 1/2 a.test.ts ✓, 1.0 s',
  '2026-11-19T10:00:03Z  ready push: running 1 explicit Test Plan command',
  '2026-11-19T10:00:04Z  command progress: ✓, 1.0 s: bun test',
  '2026-11-19T10:00:05Z  CI progress: build ✓, 1.0 s',
  '2026-11-19T10:00:06Z  driver exited with code 0'
]

test('progress lines print once, in time order, beside the records, and the driver exit does not print', () => {
  const follow = view(false)
  const records = [record(E.stepStarted, 2500, step('a', 'first'), 'started', 'a')]
  const first = follow.render({ records, gaps: [] }, progressDriver, now, true)
  expect(first.filter((line) => line.includes('progress:') || line.includes('ready push:'))).toHaveLength(5)
  expect(first.join('\n')).not.toContain('driver exited')
  const order = first.map((line) => line.slice(0, 8))
  expect(order).toEqual([...order].sort())
  expect(follow.render({ records: [], gaps: [] }, [], now, false)).toEqual([])
})

test('a progress line at or before the driver-log time already printed is not printed again', () => {
  const through = Date.parse('2026-11-19T10:00:03Z')
  const lines = view(false).render({ records: [], gaps: [] }, progressDriver, now, true, through)
  expect(lines).toHaveLength(2)
  expect(lines.join('\n')).toContain('command progress:')
  expect(lines.join('\n')).toContain('CI progress:')
})

test('--quiet keeps the progress lines and hides the details', () => {
  const records = [record(E.stepStarted, 1000, step('a', 'first'), 'started', 'a')]
  const driver = ['2026-11-19T10:00:01Z  · a detail', progressDriver[0] as string]
  const lines = view(false).render({ records, gaps: [] }, driver, now, true)
  expect(lines.join('\n')).toContain('push progress:')
  expect(lines.join('\n')).not.toContain('a detail')
})

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

test('a run whose Log SDK writer numbers from 1 reports no gap', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { connect } = await import('@attalabs/vinaya-log-sdk')
  const { readTaskRuns } = await import('./follow-records.js')
  const dir = mkdtempSync(join(tmpdir(), 'follow-first-sequence-'))
  try {
    const handle = connect({
      runId: 'run-1',
      repository: 'acme/widgets',
      runtimeDir: dir,
      repoRoot: join(dir, 'repo'),
      workRef: '7',
      provenance: 'governed'
    })
    handle.run.stageChanged({ to: 'review', round: 1 })
    handle.run.stageChanged({ to: 'develop', round: 2 })
    await handle.shutdown()
    const folder = join(dir, 'logs', 'acme-widgets')
    expect(readdirSync(folder).length).toBeGreaterThan(0)
    const update = await readTaskRuns(folder, 7, dir).pull()
    expect(update?.records).toHaveLength(2)
    expect(update?.gaps).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an agent turn converted from an earlier role attempt is narrated with its seat', () => {
  const follow = view(false)
  const turn = record(
    'invoke_agent developer',
    3000,
    { [A.agentName]: 'developer', 'vinaya.earlier.actor': 'claude', 'vinaya.earlier.outcome': 'completed' },
    'span'
  )
  expect(follow.render({ records: [turn], gaps: [] }, [], now, true)).toEqual([
    '10:00:03  ✓ Loop   The developer finished its turn.'
  ])
})

test('a run that records no steps shows the driver log step lines, a live one after one poll', () => {
  const follow = view(false)
  expect(
    follow.render(
      { records: [record(E.roundStarted, 0, { [A.roundNumber]: 1 })], gaps: [] },
      ['2026-11-19T10:00:01Z [call=a]  > Developer   Reading first', '2026-11-19T10:00:01Z  · a detail'],
      now,
      true
    )
  ).toEqual(['10:00:00  ◆ Loop   Round 1 started.', '10:00:01  ▸ Developer   Reading first'])
  const live = ['2026-11-19T10:00:05Z [call=b]  > Developer   Reading second']
  expect(follow.render({ records: [], gaps: [] }, live, now, false)).toEqual([])
  expect(follow.render({ records: [], gaps: [] }, [], now, false)).toEqual(['10:00:05  ▸ Developer   Reading second'])
  // Once a step record is seen, the driver log's step lines are not shown again.
  expect(
    follow.render(
      { records: [record(E.stepStarted, 9000, step('c', 'third'), 'started', 'c')], gaps: [] },
      ['2026-11-19T10:00:09Z [call=c]  > Developer   Reading third'],
      now,
      false
    )
  ).toEqual(['10:00:09  ▸ Developer   Reading third'])
  expect(
    follow.render(
      { records: [], gaps: [] },
      ['2026-11-19T10:00:10Z [call=d]  > Developer   Reading fourth'],
      now,
      false
    )
  ).toEqual([])
})
