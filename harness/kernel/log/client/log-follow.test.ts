import { describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceLine } from '../sync/contracts'
import {
  createFolderLogFollower,
  createServerLogFollower,
  type FolderWatch,
  type FollowStateChange,
  type FollowWait,
  type LiveSocket,
  type LiveSocketConstructor,
  type LogFollower,
  reconnectWaitMs
} from './log-follow.js'
import { repoDirFor } from './log-sync-folder-source.js'
import { type ServerSourceFetch, liveUrlFrom } from './log-sync-server-source.js'

// Both followers are proven against fakes: a fake WebSocket the test drives
// message by message, a fake `fetch` implementing the read route
// (`apps/log-server/specs/server.md` § 5), a fake file watch the test fires,
// and a fake wait that records each wait and returns at once. No network and
// no real clock — every wait below is a recorded number, never a timer.

// The standard constructor fits the injected shape, so a caller passes it as is.
const standardConstructorFits: LiveSocketConstructor = WebSocket
void standardConstructorFits

const EVENTS_URL = 'https://logs.example.com/v1/repos/acme/widget/events'
const READ_TOKEN = 'the-read-token-value-abc123'
const READ_HEADERS = { authorization: 'Bearer ${LOG_READ_TOKEN}' }
const ENV = { LOG_READ_TOKEN: READ_TOKEN }

/** Lets every pending promise chain run, without touching the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

/** A fake socket the test drives: open it, send it lines, close it. */
class FakeSocket implements LiveSocket {
  static created: FakeSocket[] = []
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  onerror: LiveSocket['onerror'] = null
  closedWith: { code?: number; reason?: string } | null = null
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    FakeSocket.created.push(this)
  }
  open(): void {
    ;(this.onopen as ((event: unknown) => void) | null)?.({})
  }
  sendEvent(seq: number, event: unknown = { n: seq }): void {
    this.onmessage?.({ data: JSON.stringify({ seq, status: 'ok', event }) })
  }
  sendRaw(data: string): void {
    this.onmessage?.({ data })
  }
  serverClose(code: number, reason = ''): void {
    this.onclose?.({ code, reason })
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '' })
  }
}

/** A fresh fake constructor with its own record of every socket it built. */
function fakeSockets(): { ctor: LiveSocketConstructor; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  class Recorded extends FakeSocket {
    constructor(url: string, protocols: string[]) {
      super(url, protocols)
      sockets.push(this)
    }
  }
  return { ctor: Recorded, sockets }
}

/** A fake read route over `events` (seq 1..n), recording each `after` asked for. */
function fakeReadRoute(events: number[], requests: string[] = []): ServerSourceFetch {
  return async (input, init) => {
    const url = new URL(input)
    requests.push(url.searchParams.get('after') ?? '')
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers.authorization !== `Bearer ${READ_TOKEN}`) return new Response(null, { status: 401 })
    const after = Number(url.searchParams.get('after') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '1000')
    const page = events.filter((seq) => seq > after).slice(0, limit)
    const body = page.map((seq) => JSON.stringify({ seq, status: 'ok', event: { n: seq } })).join('\n')
    const next = page.length > 0 ? String(page[page.length - 1]) : String(after)
    return new Response(page.length > 0 ? `${body}\n` : '', {
      status: 200,
      headers: { 'vinaya-log-next-after': next }
    })
  }
}

/** A wait that records each duration and returns at once. */
function recordingWait(): { wait: FollowWait; waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    wait: async (ms) => {
      waits.push(ms)
    }
  }
}

/** A wait that records each duration and returns only when its signal aborts. */
function stoppableWait(): { wait: FollowWait; waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    wait: (ms, signal) => {
      waits.push(ms)
      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    }
  }
}

function collect(): { lines: SourceLine[]; states: FollowStateChange[]; sink: Parameters<LogFollower['follow']>[1] } {
  const lines: SourceLine[] = []
  const states: FollowStateChange[] = []
  return {
    lines,
    states,
    sink: {
      line: (line) => lines.push(line),
      state: (change) => states.push(change)
    }
  }
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const positions = (lines: SourceLine[]): number[] => lines.map((line) => Number(line.position))

describe('liveUrlFrom', () => {
  it('swaps the events tail for live and the scheme for a WebSocket scheme', () => {
    expect(liveUrlFrom(EVENTS_URL)).toBe('wss://logs.example.com/v1/repos/acme/widget/live')
    expect(liveUrlFrom('http://localhost:8787/v1/repos/a/b/events?x=1')).toBe('ws://localhost:8787/v1/repos/a/b/live')
  })
})

describe('reconnectWaitMs', () => {
  it('doubles per attempt up to the cap', () => {
    const backoff = { initialMs: 100, maxMs: 1000 }
    expect([1, 2, 3, 4, 5, 6].map((n) => reconnectWaitMs(backoff, n))).toEqual([100, 200, 400, 800, 1000, 1000])
  })
})

describe('server follower — live (O1)', () => {
  it('opens the live route after the given position, with the token as the second subprotocol and never in the URL', async () => {
    const { ctor, sockets } = fakeSockets()
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute([]),
      wait: recordingWait().wait
    })
    const { sink } = collect()
    const handle = follower.follow('41', sink)
    await settle()

    expect(sockets).toHaveLength(1)
    const socket = sockets[0] as FakeSocket
    expect(socket.url).toBe('wss://logs.example.com/v1/repos/acme/widget/live?after=41')
    expect(socket.url).not.toContain(READ_TOKEN)
    expect(socket.protocols).toEqual(['vinaya-log.v1', `bearer.${READ_TOKEN}`])
    expect(follower.id).toBe(`server:${EVENTS_URL}`)
    await handle.stop()
  })

  it('hands each event over in position order with its position, and drops one at or below the last', async () => {
    const { ctor, sockets } = fakeSockets()
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute([]),
      wait: recordingWait().wait
    })
    const { lines, states, sink } = collect()
    const handle = follower.follow('10', sink)
    await settle()
    const socket = sockets[0] as FakeSocket
    socket.open()
    socket.sendEvent(9) // at or below the start position
    socket.sendEvent(10)
    socket.sendEvent(11, { kind: 'a' })
    socket.sendEvent(12, { kind: 'b' })
    socket.sendEvent(12) // a repeat
    socket.sendEvent(11) // out of order
    socket.sendRaw('not json')
    socket.sendEvent(13)

    expect(lines).toEqual([
      { raw: '{"kind":"a"}', position: '11' },
      { raw: '{"kind":"b"}', position: '12' },
      { raw: '{"n":13}', position: '13' }
    ])
    expect(handle.cursor()).toBe('13')
    expect(states.map((s) => s.state)).toEqual(['connecting', 'live'])
    await handle.stop()
  })

  it('stops for good, naming the variable, when the read credential is unset — no socket, no request', async () => {
    const { ctor, sockets } = fakeSockets()
    const requests: string[] = []
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: {},
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute([], requests),
      wait: recordingWait().wait
    })
    const { states, sink } = collect()
    const handle = follower.follow(null, sink)
    await handle.done
    expect(sockets).toHaveLength(0)
    expect(requests).toHaveLength(0)
    expect(states).toHaveLength(1)
    expect(states[0]?.state).toBe('stopped')
    expect(states[0]?.reason).toContain('LOG_READ_TOKEN')
  })
})

describe('server follower — resync (O2)', () => {
  it('pages with the read route from the last position until caught up, then reopens live from there, each event once', async () => {
    const { ctor, sockets } = fakeSockets()
    const requests: string[] = []
    const stored = range(1, 2500)
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute(stored, requests),
      wait: recordingWait().wait
    })
    const { lines, states, sink } = collect()
    const handle = follower.follow('5', sink)
    await settle()

    const first = sockets[0] as FakeSocket
    first.open()
    first.sendRaw(JSON.stringify({ type: 'resync', after: 5 }))
    first.serverClose(1013, 'page with the read route from the position in the resync message')
    await settle()

    // Paged from 5 in the server's page size until an empty page.
    expect(requests).toEqual(['5', '1005', '2005', '2500'])
    expect(sockets).toHaveLength(2)
    const second = sockets[1] as FakeSocket
    expect(second.url).toBe('wss://logs.example.com/v1/repos/acme/widget/live?after=2500')
    second.open()
    // The live replay overlapping what the paging delivered adds nothing.
    second.sendEvent(2499)
    second.sendEvent(2500)
    second.sendEvent(2501)

    expect(positions(lines)).toEqual(range(6, 2501))
    expect(new Set(lines.map((l) => l.position)).size).toBe(lines.length)
    expect(states.map((s) => s.state)).toEqual(['connecting', 'live', 'catching-up', 'connecting', 'live'])
    await handle.stop()
  })

  it('treats a 1013 close with no resync message the same way — the normal page-first signal, never an error', async () => {
    const { ctor, sockets } = fakeSockets()
    const { wait, waits } = recordingWait()
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute(range(1, 3)),
      wait
    })
    const { lines, states, sink } = collect()
    const handle = follower.follow(null, sink)
    await settle()
    ;(sockets[0] as FakeSocket).serverClose(1013)
    await settle()
    expect(positions(lines)).toEqual([1, 2, 3])
    expect(waits).toEqual([])
    expect(states.some((s) => s.state === 'waiting-to-reconnect')).toBe(false)
    expect((sockets[1] as FakeSocket).url).toEndWith('?after=3')
    await handle.stop()
  })

  it('waits and retries from the last position when a catch-up page fails part way', async () => {
    const { ctor, sockets } = fakeSockets()
    const { wait, waits } = recordingWait()
    let calls = 0
    const inner = fakeReadRoute(range(1, 1500))
    const flaky: ServerSourceFetch = async (input, init) => {
      calls += 1
      if (calls === 2) return new Response(null, { status: 503 })
      return inner(input, init)
    }
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: ctor,
      fetchImpl: flaky,
      wait,
      backoff: { initialMs: 100, maxMs: 1000 }
    })
    const { lines, states, sink } = collect()
    const handle = follower.follow(null, sink)
    await settle()
    ;(sockets[0] as FakeSocket).serverClose(1013)
    await settle()
    // The first page landed (1..1000); the second failed; the retry reconnects from 1000.
    expect(waits).toEqual([100])
    expect(states.map((s) => s.state)).toEqual(['connecting', 'catching-up', 'waiting-to-reconnect', 'connecting'])
    expect((sockets[1] as FakeSocket).url).toEndWith('?after=1000')
    ;(sockets[1] as FakeSocket).serverClose(1013)
    await settle()
    expect(positions(lines)).toEqual(range(1, 1500))
    await handle.stop()
  })
})

describe('server follower — drop, reconnect, stop (O3)', () => {
  it('reconnects with growing waits from the last position handed over, never from zero, and drops what it already handed over', async () => {
    const { ctor, sockets } = fakeSockets()
    const { wait, waits } = recordingWait()
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute([]),
      wait,
      backoff: { initialMs: 100, maxMs: 300 }
    })
    const { lines, states, sink } = collect()
    const handle = follower.follow('0', sink)
    await settle()

    const first = sockets[0] as FakeSocket
    first.open()
    first.sendEvent(1)
    first.sendEvent(2)
    first.serverClose(1006, 'gone')
    await settle()

    // Three failures in a row that never open: the waits grow, then cap.
    for (let i = 1; i <= 3; i++) {
      const socket = sockets[i] as FakeSocket
      expect(socket.url).toEndWith('?after=2')
      socket.serverClose(1006)
      await settle()
    }
    expect(waits).toEqual([100, 200, 300, 300])

    const back = sockets[4] as FakeSocket
    expect(back.url).toEndWith('?after=2')
    back.open()
    back.sendEvent(1)
    back.sendEvent(2) // already handed over before the drop
    back.sendEvent(3)
    expect(positions(lines)).toEqual([1, 2, 3])

    // An opened connection resets the waits.
    back.serverClose(1011)
    await settle()
    expect(waits).toEqual([100, 200, 300, 300, 100])
    const wait1 = states.find((s) => s.state === 'waiting-to-reconnect')
    expect(wait1?.reason).toContain('1006')
    expect(wait1?.waitMs).toBe(100)
    await handle.stop()
  })

  it('reconnects when the constructor itself throws', async () => {
    let attempts = 0
    const { ctor, sockets } = fakeSockets()
    const throwingOnce = function (this: unknown, url: string, protocols: string[]) {
      attempts += 1
      if (attempts === 1) throw new Error('SyntaxError: bad url')
      return new ctor(url, protocols)
    } as unknown as LiveSocketConstructor
    const { wait, waits } = recordingWait()
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: throwingOnce,
      fetchImpl: fakeReadRoute([]),
      wait,
      backoff: { initialMs: 50, maxMs: 50 }
    })
    const { states, sink } = collect()
    const handle = follower.follow(null, sink)
    await settle()
    expect(waits).toEqual([50])
    expect(sockets).toHaveLength(1)
    expect(states[1]?.reason).toContain('bad url')
    await handle.stop()
  })

  it('stops cleanly while live: closes the socket, hands nothing over afterwards, reports stopped last', async () => {
    const { ctor, sockets } = fakeSockets()
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute([]),
      wait: recordingWait().wait
    })
    const { lines, states, sink } = collect()
    const handle = follower.follow(null, sink)
    await settle()
    const socket = sockets[0] as FakeSocket
    socket.open()
    socket.sendEvent(1)
    await handle.stop()
    socket.sendEvent(2)
    await settle()

    expect(socket.closedWith?.code).toBe(1000)
    expect(positions(lines)).toEqual([1])
    expect(states.map((s) => s.state)).toEqual(['connecting', 'live', 'stopped'])
    expect(sockets).toHaveLength(1)
  })

  it('stops cleanly while waiting to reconnect, without waiting the wait out', async () => {
    const { ctor, sockets } = fakeSockets()
    const { wait, waits } = stoppableWait()
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: ENV,
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute([]),
      wait
    })
    const { states, sink } = collect()
    const handle = follower.follow(null, sink)
    await settle()
    ;(sockets[0] as FakeSocket).serverClose(1006)
    await settle()
    expect(waits).toHaveLength(1)
    await handle.stop()
    expect(states.map((s) => s.state)).toEqual(['connecting', 'waiting-to-reconnect', 'stopped'])
    expect(sockets).toHaveLength(1)
  })

  it('stops for good on a refused read credential during catch-up', async () => {
    const { ctor, sockets } = fakeSockets()
    const follower = createServerLogFollower({
      eventsUrl: EVENTS_URL,
      readHeaders: READ_HEADERS,
      env: { LOG_READ_TOKEN: 'wrong' },
      WebSocketImpl: ctor,
      fetchImpl: fakeReadRoute(range(1, 3)),
      wait: recordingWait().wait
    })
    const { lines, states, sink } = collect()
    const handle = follower.follow(null, sink)
    await settle()
    ;(sockets[0] as FakeSocket).serverClose(1013)
    await handle.done
    expect(lines).toEqual([])
    const last = states[states.length - 1]
    expect(last?.state).toBe('stopped')
    expect(last?.reason).toContain('LOG_READ_TOKEN')
    expect(last?.reason).not.toContain('wrong')
  })
})

describe('folder follower (O4)', () => {
  const REPO = { owner: 'acme', repo: 'widget' }

  function setup(): { root: string; dir: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'log-follow-'))
    const dir = repoDirFor({ folderRoot: root, repo: REPO })
    mkdirSync(dir, { recursive: true })
    return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  /** A fake watch the test fires by hand; it records the folder it was asked to watch. */
  function fakeWatch(): { watch: FolderWatch; fire: () => void; watched: string[]; closed: () => number } {
    let listener: (() => void) | null = null
    let closes = 0
    const watched: string[] = []
    return {
      watched,
      closed: () => closes,
      fire: () => listener?.(),
      watch: (dir, onChange) => {
        watched.push(dir)
        listener = onChange
        return {
          close: () => {
            closes += 1
            listener = null
          }
        }
      }
    }
  }

  it('reads what is there, then hands each appended line over with its file-and-line position, through the same interface', async () => {
    const { root, dir, cleanup } = setup()
    try {
      writeFileSync(join(dir, '7.ndjson'), '{"a":1}\n{"a":2}\n')
      const fake = fakeWatch()
      const follower: LogFollower = createFolderLogFollower({
        folderRoot: root,
        repo: REPO,
        watch: fake.watch,
        wait: recordingWait().wait
      })
      const { lines, states, sink } = collect()
      const handle = follower.follow(null, sink)
      await settle()

      expect(fake.watched).toEqual([dir])
      expect(follower.id).toBe(`folder:${dir}`)
      expect(lines).toEqual([
        { raw: '{"a":1}', position: '7:live:0' },
        { raw: '{"a":2}', position: '7:live:8' }
      ])
      expect(states.map((s) => s.state)).toEqual(['connecting', 'catching-up', 'live'])

      appendFileSync(join(dir, '7.ndjson'), '{"a":3}\n{"a":4')
      writeFileSync(join(dir, 'none.ndjson'), '{"b":1}\n')
      fake.fire()
      await settle()
      expect(lines.slice(2)).toEqual([
        { raw: '{"a":3}', position: '7:live:16' },
        { raw: '{"b":1}', position: 'none:live:0' }
      ])

      // The torn tail is handed over once it is whole, never twice.
      appendFileSync(join(dir, '7.ndjson'), '}\n')
      fake.fire()
      fake.fire()
      await settle()
      expect(lines.slice(4)).toEqual([{ raw: '{"a":4}', position: '7:live:24' }])

      await handle.stop()
      expect(fake.closed()).toBe(1)
      expect(states[states.length - 1]?.state).toBe('stopped')

      // Resuming from the cursor hands over only what came after it.
      appendFileSync(join(dir, '7.ndjson'), '{"a":5}\n')
      const again = collect()
      const resumed = follower.follow(handle.cursor(), again.sink)
      await settle()
      expect(again.lines).toEqual([{ raw: '{"a":5}', position: '7:live:32' }])
      await resumed.stop()
    } finally {
      cleanup()
    }
  })

  it('retries a folder it cannot watch with growing waits, then follows once it can', async () => {
    const { root, cleanup } = setup()
    try {
      let attempts = 0
      const inner = fakeWatch()
      const failingTwice: FolderWatch = (dir, onChange, onError) => {
        attempts += 1
        if (attempts <= 2) throw new Error('ENOENT')
        return inner.watch(dir, onChange, onError)
      }
      const { wait, waits } = recordingWait()
      const follower = createFolderLogFollower({
        folderRoot: root,
        repo: REPO,
        watch: failingTwice,
        wait,
        backoff: { initialMs: 10, maxMs: 100 }
      })
      const { states, sink } = collect()
      const handle = follower.follow(null, sink)
      await settle()
      expect(waits).toEqual([10, 20])
      expect(states.map((s) => s.state)).toEqual([
        'connecting',
        'waiting-to-reconnect',
        'connecting',
        'waiting-to-reconnect',
        'connecting',
        'catching-up',
        'live'
      ])
      expect(states[1]?.reason).toContain('ENOENT')
      await handle.stop()
    } finally {
      cleanup()
    }
  })

  it('re-arms the watch from its own cursor after the watch fails, repeating nothing', async () => {
    const { root, dir, cleanup } = setup()
    try {
      writeFileSync(join(dir, '1.ndjson'), '{"x":1}\n')
      let failWatch: ((err: unknown) => void) | null = null
      let fireChange: (() => void) | null = null
      const watch: FolderWatch = (_dir, onChange, onError) => {
        failWatch = onError
        fireChange = onChange
        return { close: () => {} }
      }
      const { wait, waits } = recordingWait()
      const follower = createFolderLogFollower({ folderRoot: root, repo: REPO, watch, wait })
      const { lines, sink } = collect()
      const handle = follower.follow(null, sink)
      await settle()
      appendFileSync(join(dir, '1.ndjson'), '{"x":2}\n')
      ;(failWatch as ((err: unknown) => void) | null)?.(new Error('watch lost'))
      await settle()
      expect(waits).toHaveLength(1)
      ;(fireChange as (() => void) | null)?.()
      await settle()
      expect(lines.map((l) => l.position)).toEqual(['1:live:0', '1:live:8'])
      await handle.stop()
    } finally {
      cleanup()
    }
  })
})
