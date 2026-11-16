import { describe, expect, test } from 'bun:test'
import {
  type ConnectionSocket,
  createMissionControlConnection,
  type MissionControlConnectionOptions
} from './mission-control-connection.ts'
import {
  RECONNECT_DELAYS_MS,
  RECONNECT_MAX_ATTEMPTS,
  SILENCE_LIMIT_MS,
  type RepositoryView,
  type TaskView
} from './mission-control-protocol.ts'

function taskView(n: number, over: Partial<TaskView> = {}): TaskView {
  return {
    task: n,
    title: `Task ${n}`,
    state: 'running',
    amber: false,
    reason: null,
    decision: null,
    pr: null,
    nowLine: 'running',
    lastSign: n,
    whoActs: 'the loop',
    command: null,
    model: null,
    rounds: [],
    tokens: {},
    ...over
  }
}

function repo(tasks: TaskView[], live = true): RepositoryView {
  return {
    id: 'r1',
    remote: 'acme/widgets',
    status: { live, connection: live ? 'live' : 'reconnecting', reason: null },
    coverage: { complete: true, limits: [] },
    tasks
  }
}

const snapshot = (generation: number, tasks: TaskView[], live = true) =>
  JSON.stringify({ v: 1, type: 'snapshot', generation, repositories: [repo(tasks, live)] })
const delta = (generation: number, task: TaskView) =>
  JSON.stringify({ v: 1, type: 'task', generation, repository: 'r1', task })

class FakeSocket implements ConnectionSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  closed = false
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  receive(data: unknown) {
    this.onmessage?.({ data })
  }
  drop() {
    this.onclose?.()
  }
}

function harness(over: Partial<MissionControlConnectionOptions> = {}) {
  const sockets: FakeSocket[] = []
  const timeouts = new Map<number, { fn: () => void; ms: number }>()
  let id = 1
  let now = 1000
  const connection = createMissionControlConnection({
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    timers: {
      setTimeout: (fn, ms) => {
        timeouts.set(id, { fn, ms })
        return id++
      },
      clearTimeout: (h) => void timeouts.delete(h as number)
    },
    clock: () => now,
    ...over
  })
  return {
    connection,
    sockets,
    timeouts,
    advance: (ms: number) => {
      now += ms
    },
    /** Fires the pending timer with the given delay. */
    fire(ms: number) {
      const entry = [...timeouts.entries()].find(([, t]) => t.ms === ms)
      if (!entry) throw new Error(`no timer of ${ms}ms; have ${[...timeouts.values()].map((t) => t.ms).join(',')}`)
      timeouts.delete(entry[0])
      entry[1].fn()
    }
  }
}

describe('mission control connection', () => {
  test('a snapshot replaces the whole picture and a task frame replaces one whole task', () => {
    const h = harness()
    h.connection.connect()
    const s = h.sockets[0] as FakeSocket
    s.receive(snapshot(1, [taskView(1), taskView(2)]))
    expect(h.connection.getState().phase).toBe('open')
    expect(Object.keys(h.connection.getState().repositories.r1?.tasks ?? {})).toEqual(['1', '2'])
    s.receive(delta(1, taskView(2, { state: 'needs_you', nowLine: 'paused' })))
    expect(h.connection.getState().repositories.r1?.tasks[2]?.state).toBe('needs_you')
    expect(h.connection.getState().repositories.r1?.tasks[1]?.state).toBe('running')
    s.receive(snapshot(2, [taskView(3)]))
    expect(Object.keys(h.connection.getState().repositories.r1?.tasks ?? {})).toEqual(['3'])
  })

  test('a frame from an older generation is ignored', () => {
    const h = harness()
    h.connection.connect()
    const s = h.sockets[0] as FakeSocket
    s.receive(snapshot(2, [taskView(1)]))
    s.receive(delta(1, taskView(1, { state: 'needs_you' })))
    expect(h.connection.getState().repositories.r1?.tasks[1]?.state).toBe('running')
  })

  test('wrong versions, unknown types and malformed frames drop the socket and never change the picture', () => {
    for (const bad of [
      JSON.stringify({ v: 2, type: 'snapshot', generation: 1, repositories: [] }),
      JSON.stringify({ v: 1, type: 'execute', command: 'x' }),
      JSON.stringify({ v: 1, type: 'task', generation: 1, repository: 'r1', task: { task: 1 } }),
      'not json',
      42
    ]) {
      const h = harness()
      h.connection.connect()
      const s = h.sockets[0] as FakeSocket
      s.receive(snapshot(1, [taskView(1)]))
      s.receive(bad)
      expect(h.connection.getState().phase).toBe('reconnecting')
      expect(h.connection.getState().repositories.r1?.tasks[1]?.state).toBe('running')
    }
  })

  test('a drop keeps the last picture and its last-update time, then reconnects with the policy delays', () => {
    const h = harness()
    h.connection.connect()
    const first = h.sockets[0] as FakeSocket
    first.receive(snapshot(1, [taskView(1)]))
    const at = h.connection.getState().lastUpdateAt
    h.advance(5000)
    first.drop()
    expect(h.connection.getState()).toMatchObject({ phase: 'reconnecting', lastUpdateAt: at, attempts: 1 })
    expect(h.connection.getState().repositories.r1?.tasks[1]).toBeDefined()
    h.fire(RECONNECT_DELAYS_MS[0] as number)
    expect(h.sockets).toHaveLength(2)
    const second = h.sockets[1] as FakeSocket
    second.drop()
    h.fire(RECONNECT_DELAYS_MS[1] as number)
    expect(h.sockets).toHaveLength(3)
  })

  test('a fresh snapshot after a gap replaces the state and resets the attempts', () => {
    const h = harness()
    h.connection.connect()
    ;(h.sockets[0] as FakeSocket).receive(snapshot(1, [taskView(1)]))
    ;(h.sockets[0] as FakeSocket).drop()
    h.fire(RECONNECT_DELAYS_MS[0] as number)
    ;(h.sockets[1] as FakeSocket).receive(snapshot(1, [taskView(9)]))
    const state = h.connection.getState()
    expect(state).toMatchObject({ phase: 'open', attempts: 0 })
    expect(Object.keys(state.repositories.r1?.tasks ?? {})).toEqual(['9'])
  })

  test('a replaced socket is ignored for good, including late frames and late closes', () => {
    const h = harness()
    h.connection.connect()
    const old = h.sockets[0] as FakeSocket
    old.receive(snapshot(1, [taskView(1)]))
    const handlers = { message: old.onmessage, close: old.onclose }
    old.drop()
    h.fire(RECONNECT_DELAYS_MS[0] as number)
    const fresh = h.sockets[1] as FakeSocket
    fresh.receive(snapshot(1, [taskView(2)]))
    handlers.message?.({ data: snapshot(5, [taskView(99)]) })
    handlers.close?.()
    expect(old.onmessage).toBeNull()
    expect(h.connection.getState().phase).toBe('open')
    expect(Object.keys(h.connection.getState().repositories.r1?.tasks ?? {})).toEqual(['2'])
  })

  test('keep-alives hold the socket open but are never an update to any task', () => {
    const h = harness()
    h.connection.connect()
    const s = h.sockets[0] as FakeSocket
    s.receive(snapshot(1, [taskView(1)]))
    const at = h.connection.getState().lastUpdateAt
    h.advance(20_000)
    s.receive(JSON.stringify({ v: 1, type: 'keepalive' }))
    expect(h.connection.getState().lastUpdateAt).toBe(at)
    expect(h.connection.getState().phase).toBe('open')
  })

  test('a socket silent past the limit is dropped and reconnected', () => {
    const h = harness()
    h.connection.connect()
    ;(h.sockets[0] as FakeSocket).receive(snapshot(1, [taskView(1)]))
    h.fire(SILENCE_LIMIT_MS)
    expect(h.connection.getState().phase).toBe('reconnecting')
  })

  test('a source that is not live stays not live in the picture', () => {
    const h = harness()
    h.connection.connect()
    ;(h.sockets[0] as FakeSocket).receive(snapshot(1, [taskView(1)], false))
    expect(h.connection.getState().repositories.r1?.status.live).toBe(false)
  })

  test('attempts are bounded; retry starts again', () => {
    const h = harness({ maxAttempts: 2, delays: [10] })
    h.connection.connect()
    ;(h.sockets[0] as FakeSocket).drop()
    h.fire(10)
    ;(h.sockets[1] as FakeSocket).drop()
    h.fire(10)
    ;(h.sockets[2] as FakeSocket).drop()
    expect(h.connection.getState().phase).toBe('failed')
    expect(h.timeouts.size).toBe(0)
    h.connection.retry()
    expect(h.sockets).toHaveLength(4)
    expect(RECONNECT_MAX_ATTEMPTS).toBeGreaterThan(0)
  })

  test('resync sends the one allowed message, and only on an open socket', () => {
    const h = harness()
    h.connection.connect()
    const s = h.sockets[0] as FakeSocket
    h.connection.resync()
    expect(s.sent).toEqual([])
    s.receive(snapshot(1, []))
    h.connection.resync()
    expect(s.sent).toEqual([JSON.stringify({ v: 1, type: 'resync' })])
  })

  test('no launch token or credential is ever sent', () => {
    const h = harness()
    h.connection.connect()
    const s = h.sockets[0] as FakeSocket
    s.receive(snapshot(1, []))
    s.drop()
    h.fire(RECONNECT_DELAYS_MS[0] as number)
    expect(h.sockets.flatMap((x) => x.sent)).toEqual([])
  })

  test('dispose releases the socket, its listeners, every timer and every subscriber', () => {
    const h = harness()
    let calls = 0
    h.connection.subscribe(() => {
      calls += 1
    })
    h.connection.connect()
    const s = h.sockets[0] as FakeSocket
    s.receive(snapshot(1, [taskView(1)]))
    s.drop()
    expect(h.timeouts.size).toBeGreaterThan(0)
    h.connection.dispose()
    expect(h.timeouts.size).toBe(0)
    expect(s.onmessage).toBeNull()
    const before = calls
    s.receive(snapshot(2, []))
    h.connection.connect()
    expect(calls).toBe(before)
    expect(h.connection.getState().phase).toBe('disposed')
    expect(h.sockets).toHaveLength(1)
  })
})
