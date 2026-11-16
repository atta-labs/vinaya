import { afterEach, describe, expect, test } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocket } from 'ws'
import type { TaskPicture } from '../../../../harness/processes/vinaya-strict/tools/mission-control/picture.ts'
import { KEEPALIVE_MS, parseServerMessage, type ServerMessage } from '../lib/mission-control-protocol.ts'
import { createStudioHost, LIVE_ROUTE, type StudioHost } from './host.ts'
import { createLiveSocket, type LiveSocket } from './live-socket.ts'
import type { PictureServiceEvent, RepositorySnapshot } from './picture-service.ts'
import { createLaunchSecret } from './session.ts'

const ROOT = '/Users/secret-person/repo-one'
const SECRET_FINDING = 'SENTINEL-FINDING-IN-GATE-READ'

function task(n: number, over: Partial<TaskPicture> = {}): TaskPicture {
  return {
    task: n,
    title: `Task ${n}`,
    state: 'running',
    amber: false,
    reason: null,
    decision: null,
    rounds: [],
    pr: null,
    nowLine: 'running',
    lastSign: n,
    whoActs: 'the loop',
    command: null,
    feed: [],
    tokens: {},
    model: null,
    models: {},
    machine: 'mac',
    reviewerRoles: [],
    loopIds: [],
    signals: { pause: null, handoff: null, stop: null, endedReady: false, exit: null },
    gateReads: { '1': { finding: SECRET_FINDING } },
    ...over
  }
}

function snapshot(tasks: TaskPicture[], live = true): RepositorySnapshot {
  return {
    repository: ROOT,
    remote: null,
    sourceKind: 'server',
    status: { live, connection: live ? 'live' : 'reconnecting', reason: null },
    coverage: { startPosition: null, complete: true, limits: [] },
    picture: { now: 1, readThrough: 1, skipped: 0, repeated: 0, tasks, loops: {} },
    partialTasks: [],
    chronologyLimitedTasks: [],
    diagnostics: {
      applied: 0,
      duplicates: 0,
      unreadable: 0,
      heldBack: 0,
      identities: 0,
      bootstrapBytes: 0,
      sequence: 0,
      lastAppliedPosition: null
    }
  }
}

function fakeService(initial: RepositorySnapshot) {
  let current = initial
  const listeners = new Set<(event: PictureServiceEvent) => void>()
  return {
    set: (next: RepositorySnapshot) => {
      current = next
    },
    emit: (event: PictureServiceEvent) => {
      for (const l of listeners) l(event)
    },
    get listeners() {
      return listeners.size
    },
    service: {
      snapshots: () => [current],
      subscribe(listener: (event: PictureServiceEvent) => void) {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    }
  }
}

function fakeTimers() {
  const intervals = new Map<number, () => void>()
  let next = 1
  return {
    timers: {
      setInterval: (handler: () => void) => {
        intervals.set(next, handler)
        return next++
      },
      clearInterval: (handle: unknown) => void intervals.delete(handle as number)
    },
    tick: () => {
      for (const h of intervals.values()) h()
    },
    get active() {
      return intervals.size
    }
  }
}

function fakeSocket() {
  const handlers: Record<string, ((data?: unknown) => void)[]> = {}
  const sent: ServerMessage[] = []
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    closed: null as { code?: number } | null,
    send: (data: string) => {
      const message = parseServerMessage(data)
      if (!message) throw new Error(`server sent an invalid frame: ${data}`)
      sent.push(message)
    },
    close(code?: number) {
      this.closed = { code }
      this.readyState = 3
    },
    on(event: string, listener: (data?: unknown) => void) {
      handlers[event] = [...(handlers[event] ?? []), listener]
    }
  }
  return {
    socket: socket as typeof socket & LiveSocket,
    sent,
    fire: (e: string, d?: unknown) => {
      for (const h of handlers[e] ?? []) h(d)
    }
  }
}

function setup(over: Partial<Parameters<typeof createLiveSocket>[0]> = {}) {
  const service = fakeService(snapshot([task(1)]))
  const t = fakeTimers()
  const endpoint = createLiveSocket({
    service: service.service,
    repositories: [{ root: ROOT }],
    timers: t.timers,
    softBufferBytes: 100,
    hardBufferBytes: 1000,
    ...over
  })
  return { service, t, endpoint }
}

describe('live socket endpoint', () => {
  test('a connection starts with a versioned snapshot under an opaque repository id', () => {
    const { endpoint } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    expect(c.sent).toHaveLength(1)
    const first = c.sent[0]
    expect(first).toMatchObject({ v: 1, type: 'snapshot', generation: 1 })
    const wire = JSON.stringify(first)
    expect(wire).toContain('"id":"r1"')
    expect(wire).not.toContain(ROOT)
    expect(wire).not.toContain(SECRET_FINDING)
  })

  test('a changed task is sent whole, keyed by repository and task, in the current generation', () => {
    const { endpoint, service } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    const next = snapshot([task(1, { state: 'needs_you', nowLine: 'paused' })])
    service.emit({ type: 'changed', repository: ROOT, tasks: [1], snapshot: next })
    const frame = c.sent.find((m) => m.type === 'task')
    expect(frame).toMatchObject({
      type: 'task',
      generation: 1,
      repository: 'r1',
      task: { task: 1, state: 'needs_you' }
    })
    expect(JSON.stringify(c.sent)).not.toContain(SECRET_FINDING)
  })

  test('status frames carry connection and coverage, so a dropped source is never shown as live', () => {
    const { endpoint, service } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    service.emit({ type: 'status', repository: ROOT, snapshot: snapshot([task(1)], false) })
    expect(c.sent.at(-1)).toMatchObject({ type: 'status', status: { live: false, connection: 'reconnecting' } })
  })

  test('a repository reopening sends a replacement snapshot in a new generation', () => {
    const { endpoint, service } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    service.emit({ type: 'snapshot', repository: ROOT, snapshot: snapshot([]) })
    expect(c.sent.at(-1)).toMatchObject({ type: 'snapshot', generation: 2 })
  })

  test('one subscription to the service serves every connection, and none is added per page', () => {
    const { endpoint, service } = setup()
    expect(service.listeners).toBe(1)
    endpoint.handler(fakeSocket().socket)
    endpoint.handler(fakeSocket().socket)
    expect(service.listeners).toBe(1)
    expect(endpoint.connections).toBe(2)
  })

  test('a keep-alive goes out on the twenty-second interval and carries no task', () => {
    expect(KEEPALIVE_MS).toBe(20_000)
    const { endpoint, t } = setup({ keepAliveMs: KEEPALIVE_MS })
    const c = fakeSocket()
    endpoint.handler(c.socket)
    t.tick()
    expect(c.sent.at(-1)).toEqual({ v: 1, type: 'keepalive' })
  })

  test('resync from the page gets a fresh snapshot in a new generation', () => {
    const { endpoint } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    c.fire('message', JSON.stringify({ v: 1, type: 'resync' }))
    expect(c.sent.at(-1)).toMatchObject({ type: 'snapshot', generation: 2 })
  })

  test('unknown, command-shaped, malformed or oversized messages close the connection and run nothing', () => {
    for (const body of [
      JSON.stringify({ v: 1, type: 'run', command: 'rm -rf /' }),
      JSON.stringify({ v: 1, type: 'resync', extra: 'x' }),
      JSON.stringify({ v: 2, type: 'resync' }),
      'not json',
      JSON.stringify({ v: 1, type: 'resync', pad: 'x'.repeat(1000) })
    ]) {
      const { endpoint } = setup()
      const c = fakeSocket()
      endpoint.handler(c.socket)
      c.fire('message', body)
      expect(c.socket.closed).not.toBeNull()
      expect(endpoint.connections).toBe(0)
    }
  })

  test('a slow client drops frames past the soft limit and is resynchronised once it drains', () => {
    const { endpoint, service } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    c.socket.bufferedAmount = 500
    service.emit({ type: 'changed', repository: ROOT, tasks: [1], snapshot: snapshot([task(1, { nowLine: 'a' })]) })
    expect(c.sent).toHaveLength(1)
    expect(endpoint.connections).toBe(1)
    c.socket.bufferedAmount = 0
    service.emit({ type: 'changed', repository: ROOT, tasks: [1], snapshot: snapshot([task(1, { nowLine: 'b' })]) })
    expect(c.sent.at(-1)).toMatchObject({ type: 'snapshot', generation: 2 })
  })

  test('a client past the hard limit is closed', () => {
    const { endpoint, service } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    c.socket.bufferedAmount = 5000
    service.emit({ type: 'changed', repository: ROOT, tasks: [1], snapshot: snapshot([task(1)]) })
    expect(c.socket.closed?.code).toBe(1013)
    expect(endpoint.connections).toBe(0)
  })

  test('closing leaves the service, ends every connection and stops every keep-alive', () => {
    const { endpoint, service, t } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    endpoint.close()
    expect(service.listeners).toBe(0)
    expect(c.socket.closed?.code).toBe(1001)
    expect(t.active).toBe(0)
    const late = fakeSocket()
    endpoint.handler(late.socket)
    expect(late.socket.closed?.code).toBe(1001)
  })

  test('a closed connection stops its keep-alive and receives nothing more', () => {
    const { endpoint, service, t } = setup()
    const c = fakeSocket()
    endpoint.handler(c.socket)
    c.fire('close')
    expect(t.active).toBe(0)
    service.emit({ type: 'changed', repository: ROOT, tasks: [1], snapshot: snapshot([task(1)]) })
    expect(c.sent).toHaveLength(1)
  })
})

describe('through the host', () => {
  const hosts: StudioHost[] = []
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.close()))
  })

  async function started() {
    const secret = createLaunchSecret()
    const service = fakeService(snapshot([task(1)]))
    let endpoint: ReturnType<typeof createLiveSocket> | null = null
    const host = createStudioHost({
      dir: '.',
      hostname: '127.0.0.1',
      port: 0,
      dev: false,
      session: { secret },
      repositories: [],
      next: () => ({
        prepare: async () => {},
        getRequestHandler: () => (_req: IncomingMessage, res: ServerResponse) => void res.end('page')
      }),
      compose: (composition) => {
        endpoint = createLiveSocket({ service: service.service, repositories: [{ root: ROOT }] })
        composition.socket(LIVE_ROUTE, (socket) => endpoint?.handler(socket as unknown as LiveSocket))
      }
    })
    hosts.push(host)
    const port = await host.listen()
    return { port, secret, endpoint: () => endpoint }
  }

  test('an upgrade without the session is refused; with it, the first frame is the snapshot', async () => {
    const { port, secret, endpoint } = await started()
    const origin = `http://127.0.0.1:${port}`

    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_ROUTE}`, { origin })
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.once('open', () => resolve(200))
    })
    expect(refused).toBe(401)

    const exchange = await fetch(`${origin}/__studio/bootstrap?token=${secret}`, { redirect: 'manual' })
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).not.toBe('')

    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_ROUTE}`, { origin, headers: { cookie } })
      ws.once('message', (data) => {
        ws.close()
        resolve(data.toString())
      })
      ws.once('error', reject)
    })
    const message = parseServerMessage(first)
    expect(message).toMatchObject({ type: 'snapshot', generation: 1 })
    expect(first).not.toContain(secret)
    expect(first).not.toContain(cookie.split('=')[1] ?? 'x')
    expect(first).not.toContain(ROOT)
    endpoint()?.close()
  })
})
