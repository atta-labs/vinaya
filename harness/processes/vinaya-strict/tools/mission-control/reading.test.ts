import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { narrate } from '../../../../kernel/log/client/narration'
import { buildExecution, EXECUTION_NAMES, type ExecutionName } from '../../../../kernel/log/fixtures/executions'
import { normalizeStoredLine } from '../../../../kernel/log/sync/normalize'
import {
  AMBER_AFTER_MS,
  emptyPicture,
  type Picture,
  PRESUMED_DEAD_AFTER_MS,
  type ReadingEvent,
  TASK_STATES,
  type TaskPicture
} from './picture'
import { reduce, reduceAll, tick } from './reading'

type Fields = Record<string, unknown>

/** An execution's lines as the reading takes them: position from 1, received when the line says it was written (an unreadable line keeps the time before it). */
function eventsOf(name: ExecutionName): ReadingEvent[] {
  let at = 0
  return buildExecution(name).lines.map((fixture, index) => {
    const line = normalizeStoredLine(fixture.raw)
    if (line.type === 'row') at = Date.parse(line.row.time)
    return { position: index + 1, receivedAt: at, line }
  })
}

function replay(events: ReadingEvent[]): Picture {
  return reduceAll(emptyPicture(), events)
}

function only(picture: Picture): TaskPicture {
  expect(picture.tasks).toHaveLength(1)
  return picture.tasks[0] as TaskPicture
}

const counts = (blocking: number, nonBlocking: number, severities: Record<string, number>) => ({
  blocking,
  nonBlocking,
  unclassified: 0,
  severities
})

// ---------------------------------------------------------------------------
// Synthetic lines, built on a real fixture header so they pass the real normaliser.

const template = JSON.parse(buildExecution('green-one-round').lines[0]?.raw as string) as Fields
const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const MIN = 60_000

let seq = 0
function line(
  task: number,
  body: Fields,
  at: number,
  extra: { round?: number; pr?: number } = {}
): ReadingEvent['line'] {
  seq += 1
  const meta = { ...(template.meta as Fields), ts: new Date(at).toISOString(), seq, event_id: `evt-test-${seq}` }
  const subject = { issue: task, role: 'unattributed', ...extra }
  return normalizeStoredLine(JSON.stringify({ meta, subject, payload: {}, ...body }))
}

const loopBody = (event: string, fields: Fields = {}) => ({
  kind: 'dev_review_loop',
  event,
  loop_id: 'loop-test',
  ...fields
})

function loopStarted(task: number, title?: string): Fields {
  return loopBody('loop_started', {
    task,
    ...(title === undefined ? {} : { title }),
    policy: { max_rounds: 5, reviewers: ['code-reviewer', 'security'], models: { developer: 'opus' } }
  })
}

/** Builds events from `[minutesAfterT0, body]` pairs for one task, positions from `start`. */
function stream(task: number, entries: Array<[number, Fields]>, start = 1): ReadingEvent[] {
  return entries.map(([minutes, body], index) => {
    const at = T0 + minutes * MIN
    const round = typeof body.round === 'number' ? body.round : undefined
    return { position: start + index, receivedAt: at, line: line(task, body, at, round === undefined ? {} : { round }) }
  })
}

const heartbeat = (task: number, round = 1) =>
  loopBody('driver_heartbeat', { task, round, phase: 'dispatch_developer' })

function stateAt(events: ReadingEvent[], minutes: number) {
  return only(tick(replay(events), T0 + minutes * MIN).picture)
}

// ---------------------------------------------------------------------------

describe('O6 — every recorded fixture execution replays into its expected picture', () => {
  it('green in one round: ready to merge, one approving round, the merge command', () => {
    const task = only(replay(eventsOf('green-one-round')))
    expect(task).toMatchObject({
      task: 101,
      title: '[fixtures] 101 — A recorded execution',
      state: 'ready_to_merge',
      amber: false,
      pr: 201,
      whoActs: 'the Principal',
      command: 'gh pr merge 201 --squash',
      model: 'sonnet',
      models: { developer: 'sonnet', 'code-reviewer': 'opus' },
      nowLine: 'The loop stopped: every check and review passed.'
    })
    expect(task.rounds).toHaveLength(1)
    expect(task.rounds[0]).toMatchObject({
      n: 1,
      outcome: 'green',
      checksGreen: true,
      agents: { developer: 'done', 'code-reviewer': 'done' },
      confidence: null,
      reviewers: [{ role: 'code-reviewer', outcome: 'approve', findings: counts(0, 0, {}), shared: false }]
    })
    expect(task.machine).toMatch(/^[0-9a-f]{64}$/)
    for (const role of ['developer', 'code-reviewer']) {
      expect(task.tokens[role]?.unknownTurns).toBe(0)
      expect(task.tokens[role]?.input).toBeGreaterThan(0)
      expect(task.tokens[role]?.output).toBeGreaterThan(0)
    }
  })

  it('three rounds: blocking and non-blocking counts and severities per round, confidence from round 2', () => {
    const task = only(replay(eventsOf('three-rounds-recurring-finding')))
    expect(task).toMatchObject({ task: 102, state: 'ready_to_merge', pr: 202 })
    expect(task.rounds.map((r) => r.outcome)).toEqual(['changes_requested', 'changes_requested', 'green'])
    expect(task.rounds.map((r) => r.confidence)).toEqual([
      null,
      { value: 70, unavailable: false, extraTurnSpent: false },
      { value: 92, unavailable: false, extraTurnSpent: true }
    ])
    expect(task.rounds[0]?.reviewers).toEqual([
      { role: 'code-reviewer', outcome: 'changes_requested', findings: counts(1, 0, { MAJOR: 1 }), shared: false }
    ])
    expect(task.rounds[1]?.reviewers).toEqual([
      {
        role: 'code-reviewer',
        outcome: 'changes_requested',
        findings: counts(1, 1, { MAJOR: 1, MINOR: 1 }),
        shared: false
      }
    ])
    // Round 3's verdicts name a security reviewer whose own findings no record gives.
    expect(task.rounds[2]?.reviewers).toEqual([
      { role: 'code-reviewer', outcome: 'approve', findings: counts(0, 0, {}), shared: false },
      { role: 'security', outcome: 'approve', findings: null, shared: true }
    ])
  })

  it('paused and resumed: the pause is answered, so the green end reads ready to merge', () => {
    const task = only(replay(eventsOf('paused-and-resumed')))
    expect(task).toMatchObject({ task: 103, state: 'ready_to_merge', pr: 203, reason: null })
    expect(task.feed.map((f) => f.text)).toContain('The loop paused for a person: an item needs a person to decide.')
    expect(task.rounds[0]?.findings).toEqual(counts(1, 1, { MAJOR: 1, LOW: 1 }))
  })

  it('escalated handoff: needs you, by its class, with no pull request and so no command', () => {
    const task = only(replay(eventsOf('escalated-handoff')))
    expect(task).toMatchObject({
      task: 104,
      state: 'needs_you',
      reason: 'strategy',
      pr: null,
      whoActs: 'the Principal',
      command: null,
      nowLine: 'Round 1 ended after 8m 48s: a role escalated, a person has to decide.'
    })
    expect(task.rounds[0]).toMatchObject({ outcome: 'escalated', agents: { developer: 'escalated' } })
  })

  it('executions with no loop record give no task: gate runs and usage alone are not a running loop', () => {
    for (const name of ['gate-two-commits', 'gate-no-commit', 'gate-same-commit-twice', 'usage-and-models'] as const) {
      const picture = replay(eventsOf(name))
      expect(picture.tasks).toEqual([])
      expect(picture.skipped).toBe(0)
    }
  })

  it('historical and hostile lines: the two lines the normaliser cannot read are skipped and counted, nothing guessed', () => {
    const picture = replay(eventsOf('historical-and-hostile-lines'))
    expect(picture.skipped).toBe(2)
    expect(picture.tasks).toEqual([])
    expect(picture.readThrough).toBe(7)
  })

  it('every task of every execution is in exactly one of the six states, at any time', () => {
    for (const name of EXECUTION_NAMES) {
      const picture = replay(eventsOf(name))
      for (const minutes of [0, 6, 11, 600]) {
        const later = tick(picture, Date.parse('2026-12-01T00:00:00.000Z') + minutes * MIN).picture
        for (const task of later.tasks) expect(TASK_STATES).toContain(task.state)
      }
    }
  })

  it('a duplicated event and a reconnection in the middle give the same picture as the clean replay', () => {
    for (const name of EXECUTION_NAMES) {
      const events = eventsOf(name)
      const clean = replay(events)
      const middle = Math.floor(events.length / 2)

      const duplicated = [...events.slice(0, middle + 1), events[middle] as ReadingEvent, ...events.slice(middle + 1)]
      expect({ ...replay(duplicated), repeated: 0 }).toEqual(clean)
      expect(replay(duplicated).repeated).toBe(1)

      // A reconnection resends everything from the start up to where it dropped, then carries on.
      const reconnected = [...events.slice(0, middle), ...events.slice(0, middle), ...events.slice(middle)]
      expect({ ...replay(reconnected), repeated: 0 }).toEqual(clean)
    }
  })
})

describe('O4 — the same events in the same position order always give the same picture', () => {
  it('two replays are equal, and the picture is plain data', () => {
    for (const name of EXECUTION_NAMES) {
      const first = replay(eventsOf(name))
      expect(replay(eventsOf(name))).toEqual(first)
      expect(JSON.parse(JSON.stringify(first))).toEqual(first)
    }
  })

  it('order is the position, never the time received', () => {
    const events = eventsOf('three-rounds-recurring-finding')
    const shuffledTimes = events.map((e, i) => ({ ...e, receivedAt: e.receivedAt + ((i * 7919) % 13) * 1000 }))
    const a = only(replay(events))
    const b = only(replay(shuffledTimes))
    expect(b.feed.map((f) => f.text)).toEqual(a.feed.map((f) => f.text))
    expect(b.state).toBe(a.state)
  })

  it('an event at a position already read changes nothing but the repeat count', () => {
    const events = eventsOf('green-one-round')
    const picture = replay(events)
    const again = reduce(picture, events[3] as ReadingEvent)
    expect({ ...again, repeated: 0 }).toEqual(picture)
    expect(again.repeated).toBe(1)
  })

  it('a gap in the positions is read past', () => {
    const events = eventsOf('green-one-round').map((e, i) => ({ ...e, position: (i + 1) * 10 }))
    expect(only(replay(events)).state).toBe('ready_to_merge')
  })

  it('events from before titles were recorded give a task with no title', () => {
    const untitled = eventsOf('green-one-round').map((event, index) => {
      if (index !== 0) return event
      const record = JSON.parse(buildExecution('green-one-round').lines[0]?.raw as string) as Fields
      delete record.title
      return { ...event, line: normalizeStoredLine(JSON.stringify(record)) }
    })
    expect(untitled[0]?.line.type).toBe('row')
    const task = only(replay(untitled))
    expect(task.title).toBeNull()
    expect(task.state).toBe('ready_to_merge')
  })

  it('a later start record with no title keeps the title an earlier one recorded', () => {
    const events = stream(7, [
      [0, loopStarted(7, '[studio-v1] 7 — A task')],
      [1, loopStarted(7)]
    ])
    expect(only(replay(events)).title).toBe('[studio-v1] 7 — A task')
  })

  it('a line the normaliser cannot read is skipped and counted', () => {
    const events = eventsOf('green-one-round')
    const garbage: ReadingEvent = { position: 5.5, receivedAt: 0, line: normalizeStoredLine('{not json') }
    const withGarbage = [...events.slice(0, 5), garbage, ...events.slice(5)]
    const picture = replay(withGarbage)
    expect(picture.skipped).toBe(1)
    expect({ ...picture, skipped: 0 }).toEqual(replay(events))
  })
})

describe('O2 — six states, in their order', () => {
  it('the order is needs you, presumed dead, stopped itself, needs a look, running, ready to merge', () => {
    expect([...TASK_STATES]).toEqual([
      'needs_you',
      'presumed_dead',
      'stopped_itself',
      'needs_a_look',
      'running',
      'ready_to_merge'
    ])
  })

  it('a pause whose reason needs a person is needs you, and silence after it never makes it dead', () => {
    const events = stream(11, [
      [0, loopStarted(11)],
      [1, loopBody('paused', { round: 1, reason: 'escalation', reason_code: 'max_rounds' })],
      [1, loopBody('driver_exited', { task: 11, reason: 'paused', last_decision: 'pause(max_rounds)' })]
    ])
    const task = stateAt(events, 600)
    expect(task).toMatchObject({ state: 'needs_you', reason: 'max_rounds', amber: false })
  })

  it('a loop silent ten minutes with no exit is presumed dead, never paused', () => {
    const events = stream(12, [
      [0, loopStarted(12)],
      [0, heartbeat(12)]
    ])
    expect(stateAt(events, 10).state).toBe('presumed_dead')
    expect(stateAt(events, 10).nowLine).toBe('No sign of life for ten minutes or more, and no exit recorded.')
  })

  it('a stop condition met is stopped itself, with its reason', () => {
    const events = stream(13, [
      [0, loopStarted(13)],
      [1, loopBody('stop_condition_met', { round: 5, condition: 'max_rounds' })]
    ])
    expect(stateAt(events, 60)).toMatchObject({ state: 'stopped_itself', reason: 'max_rounds' })
  })

  it('a pause whose reason is not recognised is needs a look, carrying the last decision word for word', () => {
    const events = stream(
      14,
      [
        [0, loopStarted(14)],
        [1, loopBody('paused', { round: 2, reason: 'principal_item', reason_code: 'brand_new_reason' })],
        [1, loopBody('driver_exited', { task: 14, reason: 'paused', last_decision: 'pause(brand_new_reason)' })]
      ],
      1
    )
    const task = stateAt(events, 60)
    expect(task).toMatchObject({ state: 'needs_a_look', decision: 'pause(brand_new_reason)' })
    expect(task.nowLine).toContain('pause(brand_new_reason)')
  })

  it('an unrecognised pause with no exit after it carries its own recorded code', () => {
    const events = stream(15, [
      [0, loopStarted(15)],
      [1, loopBody('paused', { round: 1, reason: 'refreeze_needed' })]
    ])
    expect(stateAt(events, 60)).toMatchObject({ state: 'needs_a_look', decision: 'refreeze_needed' })
  })

  it('a pause the loop answers itself leaves the liveness rules in charge', () => {
    const events = stream(16, [
      [0, loopStarted(16)],
      [1, loopBody('paused', { round: 1, reason: 'escalation', reason_code: 'stale_driver' })]
    ])
    expect(stateAt(events, 2).state).toBe('running')
    expect(stateAt(events, 11).state).toBe('presumed_dead')
  })

  it('a driver that exited on an error, with nothing else explaining it, is needs a look with its decision', () => {
    const events = stream(17, [
      [0, loopStarted(17)],
      [1, loopBody('driver_exited', { task: 17, reason: 'error', last_decision: 'publish', error_class: 'ENOENT' })]
    ])
    expect(stateAt(events, 60)).toMatchObject({ state: 'needs_a_look', decision: 'publish' })
  })

  it('a re-exec exit is not an exit: the next driver carries on, or silence makes it dead', () => {
    const events = stream(18, [
      [0, loopStarted(18)],
      [1, loopBody('driver_exited', { task: 18, reason: 'reexec', last_decision: 'publish' })]
    ])
    expect(stateAt(events, 2).state).toBe('running')
    expect(stateAt(events, 12).state).toBe('presumed_dead')
  })

  it('a finished driver ended ready; a new round clears it', () => {
    const finished = stream(19, [
      [0, loopStarted(19)],
      [0, loopBody('driver_heartbeat', { task: 19, round: 1, phase: 'publish', pr: 77 })],
      [1, loopBody('driver_exited', { task: 19, reason: 'finished', last_decision: 'publish' })]
    ])
    expect(stateAt(finished, 600)).toMatchObject({
      state: 'ready_to_merge',
      pr: 77,
      command: 'gh pr merge 77 --squash'
    })
    const reentered = [...finished, ...stream(19, [[2, loopBody('round_started', { round: 2, base_head: 'abc' })]], 4)]
    expect(stateAt(reentered, 3).state).toBe('running')
  })

  it('a resume answers the pause, and a resolved handoff stops asking for a person', () => {
    const events = stream(20, [
      [0, loopStarted(20)],
      [1, loopBody('paused', { round: 1, reason: 'principal_item' })],
      [2, { kind: 'handoff', event: 'raised', class: 'authority', reason: 'r', requested_decision: null }],
      [3, loopBody('resumed', { round: 1, by: 'principal' })]
    ])
    expect(stateAt(events, 4).state).toBe('needs_you')
    const resolved = [
      ...events,
      ...stream(
        20,
        [
          [
            4,
            { kind: 'handoff', event: 'resolved', class: 'authority', reason: 'r', resolution: null, resolved_by: null }
          ]
        ],
        5
      )
    ]
    expect(stateAt(resolved, 5).state).toBe('running')
  })

  it('who acts and the exact command follow the state and the pull request', () => {
    const dead = stream(21, [[0, loopBody('driver_heartbeat', { task: 21, round: 2, phase: 'review', pr: 88 })]])
    expect(stateAt(dead, 30)).toMatchObject({ whoActs: 'the Principal', command: 'vinaya dev-review-loop --resume 88' })
    expect(stateAt(dead, 1)).toMatchObject({ whoActs: 'the loop', command: null })
    const paused = [...dead, ...stream(21, [[1, loopBody('paused', { round: 2, reason: 'escalation' })]], 2)]
    expect(stateAt(paused, 1)).toMatchObject({
      whoActs: 'the Principal',
      command: 'vinaya pr rule 88 --file <ruling.md>'
    })
  })

  it('tasks are listed in state order, then by task number', () => {
    const events = [
      ...stream(
        31,
        [
          [0, loopStarted(31)],
          [0, loopBody('stop_condition_met', { round: 1, condition: 'green' })]
        ],
        1
      ),
      ...stream(
        32,
        [
          [0, loopStarted(32)],
          [9, heartbeat(32)]
        ],
        3
      ),
      ...stream(
        33,
        [
          [0, loopStarted(33)],
          [0, loopBody('paused', { round: 1, reason: 'escalation' })]
        ],
        5
      ),
      ...stream(34, [[0, loopStarted(34)]], 7),
      ...stream(
        30,
        [
          [0, loopStarted(30)],
          [0, loopBody('stop_condition_met', { round: 1, condition: 'no_progress' })]
        ],
        8
      )
    ]
    const picture = tick(replay(events), T0 + 12 * MIN).picture
    expect(picture.tasks.map((t) => [t.task, t.state])).toEqual([
      [33, 'needs_you'],
      [34, 'presumed_dead'],
      [30, 'stopped_itself'],
      [32, 'running'],
      [31, 'ready_to_merge']
    ])
  })
})

describe('O3 — time enters only through a tick', () => {
  const events = stream(40, [
    [0, loopStarted(40)],
    [0, heartbeat(40)]
  ])

  it('silence moves a running task to amber at five minutes and presumed dead at ten, reporting the change', () => {
    const start = tick(replay(events), T0).picture
    const four = tick(start, T0 + 4 * MIN + 59_999)
    expect(four.changed).toEqual([])
    expect(only(four.picture)).toMatchObject({ state: 'running', amber: false })

    const five = tick(four.picture, T0 + AMBER_AFTER_MS)
    expect(five.changed).toEqual([40])
    expect(only(five.picture)).toMatchObject({ state: 'running', amber: true })
    expect(only(five.picture).nowLine).toBe('No sign of life for five minutes or more.')

    const nine = tick(five.picture, T0 + 9 * MIN)
    expect(nine.changed).toEqual([])

    const ten = tick(nine.picture, T0 + PRESUMED_DEAD_AFTER_MS)
    expect(ten.changed).toEqual([40])
    expect(only(ten.picture)).toMatchObject({ state: 'presumed_dead', amber: false })
  })

  it('a sign of life brings a silent task back, and reduce never moves the clock itself', () => {
    const dead = tick(replay(events), T0 + 20 * MIN).picture
    const alive = reduce(dead, stream(40, [[21, heartbeat(40)]], 3)[0] as ReadingEvent)
    expect(alive.now).toBe(dead.now)
    expect(only(alive).state).toBe('running')
  })

  it('before any tick there is no silence, and a tick earlier than the last changes nothing', () => {
    expect(only(replay(events)).state).toBe('running')
    const later = tick(replay(events), T0 + 20 * MIN).picture
    const back = tick(later, T0)
    expect(back.changed).toEqual([])
    expect(back.picture).toBe(later)
  })
})

describe('O1 — what a task holds', () => {
  it('reviewers share one changes-requested mark when the record does not say which one blocked', () => {
    const events = stream(50, [
      [0, loopStarted(50)],
      [
        1,
        loopBody('verdicts_read', {
          round: 1,
          head: 'h1',
          all_approve: false,
          blockers: 1,
          findings: [
            { id: 'F1', severity: 'MAJOR', policy_treatment: 'blocking' },
            { id: 'F2', severity: 'MINOR', policy_treatment: 'non_blocking' },
            { id: 'F3', severity: 'NIT' }
          ]
        })
      ]
    ])
    const round = only(replay(events)).rounds[0]
    expect(round?.findings).toEqual({
      blocking: 1,
      nonBlocking: 1,
      unclassified: 1,
      severities: { MAJOR: 1, MINOR: 1, NIT: 1 }
    })
    expect(round?.reviewers).toEqual([
      { role: 'code-reviewer', outcome: 'changes_requested', findings: null, shared: true },
      { role: 'security', outcome: 'changes_requested', findings: null, shared: true }
    ])
  })

  it('a verdict listing each reviewer keeps each outcome, still sharing findings it does not attribute', () => {
    const events = stream(51, [
      [0, loopStarted(51)],
      [
        1,
        loopBody('verdicts_read', {
          round: 1,
          head: 'h1',
          all_approve: false,
          blockers: 1,
          findings: [{ id: 'F1', severity: 'HIGH', policy_treatment: 'blocking' }],
          reviewers: [
            { role: 'code-reviewer', outcome: 'approve', blockers: 0 },
            { role: 'security', outcome: 'changes_requested', blockers: 1 }
          ]
        })
      ]
    ])
    expect(only(replay(events)).rounds[0]?.reviewers).toEqual([
      { role: 'code-reviewer', outcome: 'approve', findings: null, shared: true },
      { role: 'security', outcome: 'changes_requested', findings: null, shared: true }
    ])
  })

  it('tokens a turn did not record stay unknown, never zero', () => {
    const dispatchBody = (event: string, usage: Fields | null) => ({
      kind: 'dispatch',
      event,
      target_role: 'developer',
      model: 'opus',
      round: 1,
      effect_id: 'eff-1',
      outcome: { type: 'completed' },
      usage
    })
    const unknown = stream(52, [
      [0, loopStarted(52)],
      [1, dispatchBody('outcome_received', null)]
    ])
    expect(only(replay(unknown)).tokens.developer).toEqual({ input: null, output: null, unknownTurns: 1 })
    const mixed = [...unknown, ...stream(52, [[2, dispatchBody('outcome_received', { input: 10, output: 4 })]], 3)]
    expect(only(replay(mixed)).tokens.developer).toEqual({ input: 10, output: 4, unknownTurns: 1 })
    expect(only(replay(unknown)).tokens['code-reviewer']).toBeUndefined()
  })

  it('a loop record with no Issue on its subject finds its task through its loop', () => {
    const started = stream(53, [[0, loopStarted(53, 'titled')]])
    const record = JSON.parse(buildExecution('green-one-round').lines[0]?.raw as string) as Fields
    const orphan: Fields = {
      ...record,
      subject: { issue: null, role: 'unattributed', round: 1 },
      event: 'round_started',
      loop_id: 'loop-test',
      round: 1,
      base_head: 'abc'
    }
    delete orphan.task
    delete orphan.title
    delete orphan.policy
    const event: ReadingEvent = { position: 2, receivedAt: T0 + MIN, line: normalizeStoredLine(JSON.stringify(orphan)) }
    expect(event.line.type).toBe('row')
    expect(only(replay([...started, event])).rounds.map((r) => r.n)).toEqual([1])
  })
})

describe('O5 — feed lines are the Log narration, with no reasoning and no finding text', () => {
  it("a task's feed says exactly what the terminal narration says for the same records", () => {
    for (const name of ['three-rounds-recurring-finding', 'paused-and-resumed', 'escalated-handoff'] as const) {
      const records = buildExecution(name).lines.map((l) => JSON.parse(l.raw) as Fields)
      const terminal = records
        .map((record, index) => narrate(record, records.slice(0, index)))
        .filter((l) => l !== null)
        .map((l) => l.text)
      expect(only(replay(eventsOf(name))).feed.map((f) => f.text)).toEqual(terminal)
    }
  })

  it('no feed line or now-line carries a confidence reason, a handoff reason or a finding id', () => {
    for (const name of EXECUTION_NAMES) {
      const picture = tick(replay(eventsOf(name)), Date.parse('2026-12-01T00:00:00.000Z')).picture
      const words = picture.tasks.flatMap((t) => [t.nowLine, ...t.feed.map((f) => f.text)]).join('\n')
      for (const secret of [
        'the auth path is covered',
        'every finding is addressed',
        'the brief assumes an approach',
        'keep the brief as written',
        'fnd-'
      ]) {
        expect(words).not.toContain(secret)
      }
    }
  })
})

describe('the reading is bundlable', () => {
  it('imports only the kernel narration, the normaliser row type and its own picture — no Node built-in, no I/O', () => {
    for (const file of ['reading.ts', 'picture.ts']) {
      const source = readFileSync(join(import.meta.dir, file), 'utf8')
      const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
      for (const specifier of specifiers) {
        expect(['../../../../kernel/log/client/narration', '../../../../kernel/log/sync/row', './picture']).toContain(
          specifier as string
        )
      }
    }
  })
})
