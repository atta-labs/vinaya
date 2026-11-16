import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildExecution } from '../../../../harness/kernel/log/fixtures/executions.ts'
import type { LogSource, SourceCursor, SourceLine } from '../../../../harness/kernel/log/sync/contracts.ts'
import { known, unknownBecause } from '../../../../harness/kernel/log/sync/measured.ts'
import type { RetentionStatement } from '../../../../harness/kernel/log/client/log-sync-server-source.ts'
import {
  createPictureService,
  createRealSourceFrom,
  FEED_CAP,
  FOLDER_SOURCE_FILENAME,
  LOG_FOLLOW_FILENAME,
  type FollowHandle,
  type FollowSink,
  type LogFollower,
  type PictureServiceEvent,
  type RepositorySnapshot,
  type SourceFactory
} from './picture-service.ts'
import type { StudioRepository } from './repositories.ts'

type Fields = Record<string, unknown>

// ---------------------------------------------------------------------------
// Lines: built on a real fixture header so they pass the real normaliser.

const template = JSON.parse(buildExecution('green-one-round').lines[0]?.raw as string) as Fields
const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const MIN = 60_000

let counter = 0
function raw(task: number, body: Fields, at: number | string, machine = 'mac', extra: Fields = {}): string {
  counter += 1
  const meta = {
    ...(template.meta as Fields),
    ts: typeof at === 'number' ? new Date(at).toISOString() : at,
    seq: counter,
    event_id: `evt-ps-${counter}`,
    machine
  }
  const subject = { issue: task, role: 'unattributed', ...extra }
  return JSON.stringify({ meta, subject, payload: {}, ...body })
}

const loop = (event: string, fields: Fields = {}) => ({ kind: 'dev_review_loop', event, loop_id: 'loop-ps', ...fields })
const started = (task: number, at: number, machine?: string) =>
  raw(
    task,
    loop('loop_started', {
      task,
      title: `Task ${task}`,
      policy: { max_rounds: 5, reviewers: ['code-reviewer'], models: {} }
    }),
    at,
    machine
  )
const round = (task: number, n: number, at: number, machine?: string) =>
  raw(task, loop('round_started', { round: n, base_head: 'abc' }), at, machine, { round: n })
const green = (task: number, at: number, machine?: string) =>
  raw(task, loop('stop_condition_met', { round: 1, condition: 'green' }), at, machine)

// ---------------------------------------------------------------------------
// Fakes

function repository(root: string, spec: StudioRepository['source']): StudioRepository {
  return { root, remote: null, source: spec }
}
const serverRepo = (root = '/r/server') =>
  repository(root, { ok: true, spec: { kind: 'server', url: 'https://log.test/events', readHeaders: undefined } })
const folderRepo = (root = '/r/folder') =>
  repository(root, { ok: true, spec: { kind: 'folder', folderRoot: '/logs', repoDir: '/logs/unresolved' } })

type Followed = { from: SourceCursor | null; sink: FollowSink; handle: FollowHandle & { stopped: boolean } }

function fakeFollower() {
  const calls: Followed[] = []
  const follower: LogFollower = {
    id: 'fake',
    follow(from, sink) {
      const handle = {
        stopped: false,
        cursor: () => from,
        async stop() {
          handle.stopped = true
        },
        done: new Promise<void>(() => {})
      }
      calls.push({ from, sink, handle })
      return handle
    }
  }
  return { follower, calls }
}

/** A server source over numbered events; `pages` records the cursors it was asked for. */
function serverFactory(
  events: string[],
  options: { head?: number | null; reason?: string } = {}
): { factory: SourceFactory; calls: Followed[]; pages: (string | null)[]; created: () => number } {
  const { follower, calls } = fakeFollower()
  const pages: (string | null)[] = []
  let created = 0
  const head = options.head === undefined ? events.length : options.head
  const factory: SourceFactory = () => {
    created += 1
    const source: LogSource & { retention: () => Promise<RetentionStatement> } = {
      id: 'server:fake',
      async readPage(cursor, limit) {
        pages.push(cursor)
        const after = cursor === null ? 0 : Number(cursor)
        const lines: SourceLine[] = events
          .slice(after, after + limit)
          .map((r, i) => ({ raw: r, position: String(after + i + 1) }))
        return { lines, next: lines.length === 0 ? null : (lines.at(-1) as SourceLine).position, gaps: [] }
      },
      async retention() {
        const stated = head === null ? unknownBecause<number>(options.reason ?? 'unreachable') : known(head)
        return {
          head: stated,
          storedCount: head === null ? unknownBecause<number>('unreachable') : known(head),
          gap: head === null ? unknownBecause<number>('unreachable') : known(0)
        }
      }
    }
    return { source, follower }
  }
  return { factory, calls, pages, created: () => created }
}

/** A folder source: lines are `{stream, raw}`; positions are `<stream>:live:<n>`. */
function folderFactory(lines: { stream: string; raw: string }[]): { factory: SourceFactory; calls: Followed[] } {
  const { follower, calls } = fakeFollower()
  const factory: SourceFactory = () => {
    const source: LogSource = {
      id: 'folder:fake',
      async readPage(cursor, limit) {
        const from = cursor === null ? 0 : Number(cursor)
        const slice = lines.slice(from, from + limit)
        return {
          lines: slice.map((l, i) => ({ raw: l.raw, position: `${l.stream}:live:${from + i}` })),
          next: String(from + slice.length),
          gaps: []
        }
      }
    }
    return { source, follower }
  }
  return { factory, calls }
}

function fakeTimers() {
  const handlers = new Map<number, () => void>()
  let next = 1
  return {
    timers: {
      setInterval: (h: () => void) => {
        handlers.set(next, h)
        return next++
      },
      clearInterval: (id: unknown) => {
        handlers.delete(id as number)
      }
    },
    fire: () => {
      for (const h of [...handlers.values()]) h()
    },
    active: () => handlers.size
  }
}

function clockAt(start: number) {
  let now = start
  return {
    now: () => now,
    set: (t: number) => {
      now = t
    }
  }
}

function taskOf(snapshot: RepositorySnapshot | null, task: number) {
  return snapshot?.picture.tasks.find((t) => t.task === task)
}

// ---------------------------------------------------------------------------

describe('opening a server source on its recent stretch', () => {
  const events = [
    started(7, T0),
    round(7, 1, T0 + MIN),
    round(7, 2, T0 + 2 * MIN),
    round(7, 3, T0 + 3 * MIN),
    green(7, T0 + 4 * MIN)
  ]

  test('head above the stretch: starts at head minus stretch, declares opening-limited, follows from the last position read', async () => {
    const s = serverFactory(events)
    const clock = clockAt(T0 + 5 * MIN)
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clock.now,
      stretch: 2
    })
    await service.start()
    const snap = service.snapshot('/r/server')
    expect(snap?.coverage.startPosition).toBe('3')
    expect(snap?.coverage.limits.map((l) => l.kind)).toContain('opening-limited')
    expect(snap?.coverage.complete).toBe(false)
    expect(s.pages[0]).toBe('3')
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]?.from).toBe('5')
    expect(snap?.diagnostics.applied).toBe(2)
    await service.close()
  })

  test('head below the stretch: starts at the beginning and declares no opening limit', async () => {
    const s = serverFactory(events)
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + 5 * MIN).now,
      stretch: 100
    })
    await service.start()
    const snap = service.snapshot('/r/server')
    expect(snap?.coverage.startPosition).toBe('0')
    expect(snap?.coverage.complete).toBe(true)
    expect(taskOf(snap, 7)?.state).toBe('ready_to_merge')
    expect(snap?.partialTasks).toEqual([])
    await service.close()
  })

  test('head unknown: reports the source reason and starts nothing', async () => {
    const s = serverFactory(events, { head: null, reason: 'the read credential was refused' })
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0).now
    })
    await service.start()
    const snap = service.snapshot('/r/server')
    expect(snap?.status).toEqual({ live: false, connection: 'unavailable', reason: 'the read credential was refused' })
    expect(s.pages).toEqual([])
    expect(s.calls).toHaveLength(0)
    expect(snap?.picture.tasks).toEqual([])
    await service.close()
  })

  test('a stretch beginning in the middle of a task keeps what its events show and marks the task partial', async () => {
    const s = serverFactory(events)
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + 5 * MIN).now,
      stretch: 3
    })
    await service.start()
    const snap = service.snapshot('/r/server')
    const task = taskOf(snap, 7)
    expect(task?.title).toBeNull()
    expect(snap?.partialTasks).toEqual([7])
    expect(snap?.picture.tasks[0]?.rounds.map((r) => r.n)).toEqual([2, 3])
    await service.close()
  })

  test('pages at the injected page bound until a page brings nothing', async () => {
    const s = serverFactory(events)
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + 5 * MIN).now,
      pageSize: 2
    })
    await service.start()
    expect(s.pages).toEqual(['0', '2', '4', '5'])
    expect(s.calls[0]?.from).toBe('5')
    await service.close()
  })

  test('a second subscriber shares the one follower and the one picture', async () => {
    const s = serverFactory(events)
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + 5 * MIN).now
    })
    const a: PictureServiceEvent[] = []
    const b: PictureServiceEvent[] = []
    service.subscribe((e) => a.push(e))
    await service.start()
    service.subscribe((e) => b.push(e))
    s.calls[0]?.sink.line({ raw: round(7, 4, T0 + 5 * MIN), position: '6' })
    expect(s.created()).toBe(1)
    expect(s.calls).toHaveLength(1)
    expect(a.at(-1)?.type).toBe('changed')
    expect(b.at(-1)).toEqual(a.at(-1) as PictureServiceEvent)
    await service.close()
  })
})

describe('replay, duplicates and reconnects', () => {
  test('a duplicate identity at another position changes nothing; a reconnect backlog is aged by its recorded time', async () => {
    const first = started(9, T0)
    const s = serverFactory([first])
    const clock = clockAt(T0 + 1 * MIN)
    const service = createPictureService({ repositories: [serverRepo()], createSource: s.factory, clock: clock.now })
    await service.start()
    const sink = (s.calls[0] as Followed).sink
    sink.state?.({ state: 'live' })
    clock.set(T0 + 20 * MIN)
    sink.line({ raw: first, position: '2' })
    expect(service.snapshot('/r/server')?.diagnostics.duplicates).toBe(1)

    // The server drops, comes back and replays a backlog while reporting live: it is not read as fresh.
    sink.state?.({ state: 'waiting-to-reconnect', reason: 'closed', waitMs: 1000 })
    expect(service.snapshot('/r/server')?.status.live).toBe(false)
    sink.state?.({ state: 'live' })
    sink.line({ raw: round(9, 1, T0 + 2 * MIN), position: '3' })
    const task = service.snapshot('/r/server')?.picture.tasks[0]
    expect(task?.lastSign).toBe(T0 + 2 * MIN)
    await service.close()
  })

  test('a live event takes the local receipt time, not its recorded one', async () => {
    const s = serverFactory([started(9, T0)])
    const clock = clockAt(T0 + 1 * MIN)
    const service = createPictureService({ repositories: [serverRepo()], createSource: s.factory, clock: clock.now })
    await service.start()
    const sink = (s.calls[0] as Followed).sink
    sink.state?.({ state: 'live' })
    clock.set(T0 + 30 * MIN)
    sink.line({ raw: round(9, 1, T0 + 2 * MIN), position: '2' })
    expect(service.snapshot('/r/server')?.picture.tasks[0]?.lastSign).toBe(T0 + 30 * MIN)
    await service.close()
  })

  test('two repositories with the same task number keep separate pictures', async () => {
    const a = serverFactory([started(5, T0)])
    const b = serverFactory([started(5, T0), green(5, T0 + MIN)])
    const factory: SourceFactory = (spec, repo) =>
      repo.root === '/r/a' ? a.factory(spec, repo) : b.factory(spec, repo)
    const service = createPictureService({
      repositories: [serverRepo('/r/a'), serverRepo('/r/b')],
      createSource: factory,
      clock: clockAt(T0 + 2 * MIN).now
    })
    await service.start()
    expect(taskOf(service.snapshot('/r/a'), 5)?.state).toBe('running')
    expect(taskOf(service.snapshot('/r/b'), 5)?.state).toBe('ready_to_merge')
    await service.close()
  })

  test('unreadable records are counted and declared, never guessed', async () => {
    const s = serverFactory(['{not json', started(1, T0)])
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + MIN).now
    })
    await service.start()
    const snap = service.snapshot('/r/server')
    expect(snap?.diagnostics.unreadable).toBe(1)
    expect(snap?.coverage.limits.map((l) => l.kind)).toContain('unreadable-records')
    expect(snap?.picture.tasks).toHaveLength(1)
    await service.close()
  })

  test('a refused credential ends the follow as unavailable, with the reason', async () => {
    const s = serverFactory([started(1, T0)])
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0).now
    })
    await service.start()
    ;(s.calls[0] as Followed).sink.state?.({ state: 'stopped', reason: 'the read credential was refused' })
    expect(service.snapshot('/r/server')?.status).toEqual({
      live: false,
      connection: 'unavailable',
      reason: 'the read credential was refused'
    })
    await service.close()
  })

  test('a repository with no usable source is unavailable with its own message and starts nothing', async () => {
    const s = serverFactory([])
    const repo = repository('/r/none', { ok: false, code: 'logs_disabled', message: 'no Log recorded' })
    const service = createPictureService({ repositories: [repo], createSource: s.factory })
    await service.start()
    expect(service.snapshot('/r/none')?.status.reason).toBe('no Log recorded')
    expect(s.created()).toBe(0)
    await service.close()
  })
})

describe('silence is the clock’s alone', () => {
  test('old history reads dead once the clock ticks; amber then dead move only on the timer', async () => {
    const s = serverFactory([started(3, T0)])
    const clock = clockAt(T0 + 1 * MIN)
    const t = fakeTimers()
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clock.now,
      timers: t.timers
    })
    const events: PictureServiceEvent[] = []
    service.subscribe((e) => events.push(e))
    await service.start()
    expect(taskOf(service.snapshot('/r/server'), 3)).toMatchObject({ state: 'running', amber: false })

    clock.set(T0 + 6 * MIN)
    expect(taskOf(service.snapshot('/r/server'), 3)?.amber).toBe(false) // no event or read moves silence
    t.fire()
    expect(taskOf(service.snapshot('/r/server'), 3)).toMatchObject({ state: 'running', amber: true })
    clock.set(T0 + 11 * MIN)
    t.fire()
    expect(taskOf(service.snapshot('/r/server'), 3)?.state).toBe('presumed_dead')
    expect(events.filter((e) => e.type === 'changed').map((e) => (e as { tasks: number[] }).tasks)).toEqual([[3], [3]])
    await service.close()
  })

  test('opening on an hour-old Log shows the task dead at once, not running', async () => {
    const s = serverFactory([started(3, T0)])
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + 60 * MIN).now
    })
    await service.start()
    expect(taskOf(service.snapshot('/r/server'), 3)?.state).toBe('presumed_dead')
    await service.close()
  })

  test('an unreadable recorded time is unknown freshness, never a heartbeat', async () => {
    const s = serverFactory([
      started(3, T0),
      raw(3, loop('round_started', { round: 1, base_head: 'abc' }), 'not a date')
    ])
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + 60 * MIN).now
    })
    await service.start()
    expect(service.snapshot('/r/server')?.picture.tasks[0]?.lastSign).toBe(T0)
    await service.close()
  })
})

describe('folder source', () => {
  const m1 = [started(4, T0, 'm1'), round(4, 1, T0 + 2 * MIN, 'm1')]
  const m2 = [round(4, 2, T0 + 3 * MIN, 'm2'), green(4, T0 + 4 * MIN, 'm2')]

  async function openWith(first: string, second: string) {
    const lines = [...m1.map((r) => ({ stream: first, raw: r })), ...m2.map((r) => ({ stream: second, raw: r }))]
    const f = folderFactory(lines)
    const service = createPictureService({
      repositories: [folderRepo()],
      createSource: f.factory,
      clock: clockAt(T0 + 5 * MIN).now
    })
    await service.start()
    return { service, f }
  }

  test('reversed machine stream names give the same task result', async () => {
    const a = await openWith('aaa', 'zzz')
    const b = await openWith('zzz', 'aaa')
    const pick = (s: typeof a.service) => {
      const t = s.snapshot('/r/folder')?.picture.tasks[0]
      return { state: t?.state, rounds: t?.rounds.map((r) => r.n), title: t?.title }
    }
    expect(pick(a.service)).toEqual({ state: 'ready_to_merge', rounds: [1, 2], title: 'Task 4' })
    expect(pick(b.service)).toEqual(pick(a.service))
    expect(a.f.calls[0]?.from).toBe('4')
    await a.service.close()
    await b.service.close()
  })

  test('opens on everything the folder holds and declares rotated slots unread', async () => {
    const { service } = await openWith('aaa', 'zzz')
    const snap = service.snapshot('/r/folder')
    expect(snap?.diagnostics.applied).toBe(4)
    expect(snap?.coverage.limits.map((l) => l.kind)).toContain('rotation-unknown')
    expect(snap?.coverage.complete).toBe(false)
    await service.close()
  })

  test('a start event only in a rotated slot leaves the task partial with unknown title', async () => {
    const f = folderFactory([{ stream: 'm1', raw: round(8, 3, T0 + MIN, 'm1') }])
    const service = createPictureService({
      repositories: [folderRepo()],
      createSource: f.factory,
      clock: clockAt(T0 + 2 * MIN).now
    })
    await service.start()
    const snap = service.snapshot('/r/folder')
    expect(snap?.partialTasks).toEqual([8])
    expect(taskOf(snap, 8)?.title).toBeNull()
    expect(snap?.coverage.limits.map((l) => l.kind)).toContain('rotation-unknown')
    await service.close()
  })

  test('an unreadable time or contradictory stream is source-limited, not authoritative', async () => {
    const f = folderFactory([
      { stream: 'm1', raw: started(2, T0, 'm1') },
      { stream: 'm1', raw: raw(2, loop('round_started', { round: 1, base_head: 'abc' }), 'garbage', 'm1') }
    ])
    const service = createPictureService({
      repositories: [folderRepo()],
      createSource: f.factory,
      clock: clockAt(T0 + MIN).now
    })
    await service.start()
    expect(service.snapshot('/r/folder')?.coverage.limits.map((l) => l.kind)).toContain('source-limited')
    await service.close()
  })

  test('same-instant records of one task from two machines are flagged, a loop start sorts first', async () => {
    const f = folderFactory([
      { stream: 'a', raw: round(6, 1, T0 + MIN, 'a') },
      { stream: 'b', raw: round(6, 2, T0 + MIN, 'b') },
      { stream: 'c', raw: started(6, T0 + MIN, 'c') }
    ])
    const service = createPictureService({
      repositories: [folderRepo()],
      createSource: f.factory,
      clock: clockAt(T0 + 2 * MIN).now
    })
    await service.start()
    const snap = service.snapshot('/r/folder')
    expect(snap?.partialTasks).toEqual([]) // the start was read before its same-time rounds
    expect(snap?.coverage.limits.map((l) => l.kind)).toContain('source-limited')
    await service.close()
  })

  test('a late old record after a newer terminal one is held back, never a silent rollback', async () => {
    const f = folderFactory([
      { stream: 'm1', raw: started(4, T0, 'm1') },
      { stream: 'm2', raw: green(4, T0 + 4 * MIN, 'm2') }
    ])
    const clock = clockAt(T0 + 5 * MIN)
    const service = createPictureService({ repositories: [folderRepo()], createSource: f.factory, clock: clock.now })
    await service.start()
    expect(taskOf(service.snapshot('/r/folder'), 4)?.state).toBe('ready_to_merge')
    const sink = (f.calls[0] as Followed).sink
    sink.state?.({ state: 'live' })
    // an old machine's round start, recorded before the terminal record
    sink.line({ raw: round(4, 2, T0 + 2 * MIN, 'm1'), position: 'm1:live:99' })
    const snap = service.snapshot('/r/folder')
    expect(taskOf(snap, 4)?.state).toBe('ready_to_merge')
    expect(snap?.picture.tasks[0]?.rounds).toEqual([])
    expect(snap?.chronologyLimitedTasks).toEqual([4])
    expect(snap?.diagnostics.heldBack).toBe(1)
    expect(snap?.coverage.limits.map((l) => l.kind)).toContain('chronology-limited')
    await service.close()
  })
})

describe('materialization budgets', () => {
  async function run(
    options: Parameters<typeof createPictureService>[0]['budgets'],
    events: string[],
    followed = true
  ) {
    const s = serverFactory(events)
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + 10 * MIN).now,
      budgets: options
    })
    await service.start()
    return { service, s, followed }
  }

  test('identity budget: stops at the last applied position, keeps the picture, declares capacity', async () => {
    const { service, s } = await run({ identities: 2 }, [
      started(1, T0),
      round(1, 1, T0 + MIN),
      round(1, 2, T0 + 2 * MIN)
    ])
    const snap = service.snapshot('/r/server')
    expect(snap?.coverage.limits.map((l) => l.kind)).toContain('capacity-limited')
    expect(snap?.diagnostics.lastAppliedPosition).toBe('2')
    expect(snap?.diagnostics.identities).toBe(2)
    expect(snap?.status.live).toBe(false)
    expect(snap?.picture.tasks).toHaveLength(1)
    expect(s.calls).toHaveLength(0)
    await service.close()
  })

  test('task budget keeps existing tasks and refuses the next', async () => {
    const { service } = await run({ tasks: 1 }, [started(1, T0), started(2, T0 + MIN)])
    const snap = service.snapshot('/r/server')
    expect(snap?.picture.tasks.map((t) => t.task)).toEqual([1])
    expect(snap?.coverage.limits.map((l) => l.kind)).toContain('capacity-limited')
    await service.close()
  })

  test('rounds budget', async () => {
    const { service } = await run({ roundsPerTask: 1 }, [
      started(1, T0),
      round(1, 1, T0 + MIN),
      round(1, 2, T0 + 2 * MIN)
    ])
    const snap = service.snapshot('/r/server')
    expect(snap?.picture.tasks[0]?.rounds).toHaveLength(1)
    expect(snap?.coverage.limits.some((l) => l.kind === 'capacity-limited')).toBe(true)
    await service.close()
  })

  test('bootstrap byte budget', async () => {
    const first = started(1, T0)
    const { service } = await run({ bootstrapBytes: first.length + 10 }, [first, round(1, 1, T0 + MIN)])
    const snap = service.snapshot('/r/server')
    expect(snap?.diagnostics.applied).toBe(1)
    expect(snap?.coverage.limits.some((l) => l.kind === 'capacity-limited')).toBe(true)
    await service.close()
  })

  test('budget exhaustion while following stops the follower', async () => {
    const s = serverFactory([started(1, T0)])
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0 + MIN).now,
      budgets: { identities: 2 }
    })
    await service.start()
    const call = s.calls[0] as Followed
    call.sink.line({ raw: round(1, 1, T0 + MIN), position: '2' })
    call.sink.line({ raw: round(1, 2, T0 + MIN), position: '3' })
    expect(call.handle.stopped).toBe(true)
    expect(service.snapshot('/r/server')?.diagnostics.lastAppliedPosition).toBe('2')
    await service.close()
  })

  test('the feed cap drops old narration only', async () => {
    const events = [started(1, T0)]
    for (let n = 1; n <= FEED_CAP + 20; n++) events.push(round(1, n, T0 + n * 1000))
    const { service } = await run(undefined, events)
    const task = service.snapshot('/r/server')?.picture.tasks[0]
    expect(task?.feed.length).toBeLessThanOrEqual(FEED_CAP)
    expect(task?.rounds).toHaveLength(FEED_CAP + 20)
    await service.close()
  })
})

describe('shutdown', () => {
  test('close clears the one timer, stops every follower and silences listeners; idempotent', async () => {
    const s = serverFactory([started(1, T0)])
    const t = fakeTimers()
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0).now,
      timers: t.timers
    })
    const seen: PictureServiceEvent[] = []
    service.subscribe((e) => seen.push(e))
    await service.start()
    expect(t.active()).toBe(1)
    await service.close()
    await service.close()
    expect(t.active()).toBe(0)
    expect(s.calls.every((c) => c.handle.stopped)).toBe(true)
    const count = seen.length
    ;(s.calls[0] as Followed).sink.line({ raw: round(1, 1, T0), position: '2' })
    expect(seen).toHaveLength(count)
  })

  test('closing during opening starts no follower', async () => {
    const s = serverFactory([started(1, T0)])
    const service = createPictureService({
      repositories: [serverRepo()],
      createSource: s.factory,
      clock: clockAt(T0).now
    })
    const opening = service.start()
    await service.close()
    await opening
    expect(s.calls).toHaveLength(0)
  })
})

describe('the real source loads the host runtime files from its own folder', () => {
  const withRuntime = async (files: Record<string, string>, run: (dir: URL) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-runtime-'))
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
      await run(pathToFileURL(`${dir}/`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a folder spec takes the follower and the folder source from the runtime files', async () => {
    await withRuntime(
      {
        [LOG_FOLLOW_FILENAME]: `export const createFolderLogFollower = (d) => ({ id: 'follower:' + d.folderRoot })\nexport const createServerLogFollower = () => ({ id: 'server' })\n`,
        [FOLDER_SOURCE_FILENAME]: `export const createFolderLogSource = (d) => ({ id: 'source:' + d.folderRoot })\n`
      },
      async (dir) => {
        const handle = await createRealSourceFrom(dir)(
          { kind: 'folder', folderRoot: '/logs', repoDir: '/logs/x' },
          folderRepo()
        )
        expect(handle.follower.id).toBe('follower:/logs')
        expect((handle.source as unknown as { id: string }).id).toBe('source:/logs')
      }
    )
  })

  test('a missing runtime file rejects, and the service shows the repository disconnected with the reason', async () => {
    await withRuntime({}, async (dir) => {
      const service = createPictureService({
        repositories: [folderRepo()],
        createSource: createRealSourceFrom(dir),
        clock: clockAt(T0).now,
        timers: fakeTimers().timers
      })
      await service.start()
      const snapshot = service.snapshots()[0] as RepositorySnapshot
      expect(snapshot.status.connection).toBe('unavailable')
      expect(snapshot.status.live).toBe(false)
      expect(snapshot.status.reason).toContain(LOG_FOLLOW_FILENAME)
      await service.close()
    })
  })
})
