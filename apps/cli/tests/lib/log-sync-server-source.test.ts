import { describe, expect, it } from 'bun:test'
import {
  createServerLogSource,
  SERVER_SOURCE_PAGE_MAX,
  ServerSourceError,
  type ServerSourceFetch,
  rejectedUrlFrom,
  statsUrlFrom
} from '../../src/lib/log-sync-server-source.js'

// The server source is proven against a fake `fetch` that implements the log
// server's own wire contract (`apps/log-server/specs/server.md` § 5) — no
// network, no real server, so every case below is reproducible on CI (O6).

const EVENTS_URL = 'https://logs.example.com/v1/repos/acme/widget/events'
const READ_TOKEN = 'the-read-token-value-abc123'

type StoredEvent = { seq: number; event: unknown }

type RejectedConfig =
  | 'missing'
  | {
      window: number
      reasons: { reason: string; count: number }[]
      recent: { id: number; received_at: number; reason: string; line: string | null }[]
    }

/** A fake implementing just enough of the log server's wire contract (events/stats/rejected, token-gated) to prove the source with no network. */
function createFakeServer(opts: {
  events: StoredEvent[]
  readToken?: string
  rejected?: RejectedConfig
  statsEventsOverride?: number
  requests?: string[]
}): ServerSourceFetch {
  const token = opts.readToken ?? READ_TOKEN
  return async (input, init) => {
    const url = new URL(input)
    opts.requests?.push(url.pathname + url.search)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers.authorization !== `Bearer ${token}`) {
      return new Response(null, { status: 401 })
    }
    if (url.pathname.endsWith('/stats')) {
      const lastSeq = opts.events.length > 0 ? (opts.events[opts.events.length - 1] as StoredEvent).seq : 0
      const eventsCount = opts.statsEventsOverride ?? opts.events.length
      return Response.json({
        repo: 'acme/widget',
        events: eventsCount,
        rejected: 0,
        bytes: 0,
        oldest_ts: null,
        newest_ts: null,
        last_seq: lastSeq
      })
    }
    if (url.pathname.endsWith('/rejected')) {
      if (opts.rejected === undefined || opts.rejected === 'missing') {
        return new Response(null, { status: 404 })
      }
      return Response.json({
        repo: 'acme/widget',
        window: opts.rejected.window,
        reasons: opts.rejected.reasons,
        recent: opts.rejected.recent
      })
    }
    // the read route
    const after = Number(url.searchParams.get('after') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '1000')
    const page = opts.events.filter((e) => e.seq > after).slice(0, limit)
    const body =
      page.length > 0
        ? `${page.map((e) => JSON.stringify({ seq: e.seq, status: 'ok', event: e.event })).join('\n')}\n`
        : ''
    const next = page.length > 0 ? String((page[page.length - 1] as StoredEvent).seq) : String(after)
    return new Response(body, { status: 200, headers: { 'vinaya-log-next-after': next } })
  }
}

function events(seqs: number[]): StoredEvent[] {
  return seqs.map((seq) => ({ seq, event: { meta: { event_id: `e${seq}` }, kind: 'operation', event: 'completed' } }))
}

function source(overrides: {
  fetchImpl: ServerSourceFetch
  readHeaders?: Record<string, string>
  env?: NodeJS.ProcessEnv
}) {
  return createServerLogSource({
    fetchImpl: overrides.fetchImpl,
    eventsUrl: EVENTS_URL,
    readHeaders: overrides.readHeaders ?? { authorization: 'Bearer ${LOG_READ_TOKEN}' },
    env: overrides.env ?? { LOG_READ_TOKEN: READ_TOKEN }
  })
}

describe('log-sync-server-source — URL derivation (shared with log selftest)', () => {
  it('derives the stats and rejected URLs by swapping the events tail', () => {
    expect(statsUrlFrom(EVENTS_URL)).toBe('https://logs.example.com/v1/repos/acme/widget/stats')
    expect(rejectedUrlFrom(EVENTS_URL)).toBe('https://logs.example.com/v1/repos/acme/widget/rejected')
  })

  it('preserves a query string on the events URL', () => {
    expect(statsUrlFrom(`${EVENTS_URL}?after=5`)).toBe('https://logs.example.com/v1/repos/acme/widget/stats?after=5')
  })
})

describe('log-sync-server-source — paging by position (O1)', () => {
  it('pages forward using the server-returned position as the next cursor', async () => {
    const fake = createFakeServer({ events: events([1, 2, 3, 4, 5]) })
    const src = source({ fetchImpl: fake })

    const page1 = await src.readPage(null, 2)
    expect(page1.lines.map((l) => l.position)).toEqual(['1', '2'])
    expect(page1.next).toBe('2')

    const page2 = await src.readPage(page1.next, 2)
    expect(page2.lines.map((l) => l.position)).toEqual(['3', '4'])
    expect(page2.next).toBe('4')

    const page3 = await src.readPage(page2.next, 2)
    expect(page3.lines.map((l) => l.position)).toEqual(['5'])
    expect(page3.next).toBe('5')
  })

  it('hands back the raw stored event, not the read envelope', async () => {
    const fake = createFakeServer({ events: events([1]) })
    const src = source({ fetchImpl: fake })
    const page = await src.readPage(null, 10)
    expect(JSON.parse((page.lines[0] as { raw: string }).raw)).toEqual({
      meta: { event_id: 'e1' },
      kind: 'operation',
      event: 'completed'
    })
  })

  it('a caught-up empty page reports next as null — the LogSource contract\'s "nothing followed" (Traps, F1)', async () => {
    const fake = createFakeServer({ events: events([1, 2]) })
    const src = source({ fetchImpl: fake })
    const page = await src.readPage('2', 10)
    expect(page.lines).toEqual([])
    expect(page.next).toBeNull()
  })

  it('reads at most the page bound it is given, capped at the server max (O1, Traps: do not scan)', async () => {
    const requests: string[] = []
    const fake = createFakeServer({ events: events([1]), requests })
    const src = source({ fetchImpl: fake })
    await src.readPage(null, 50)
    expect(requests[0]).toContain('limit=50')

    await src.readPage(null, SERVER_SOURCE_PAGE_MAX + 500)
    expect(requests[1]).toContain(`limit=${SERVER_SOURCE_PAGE_MAX}`)
  })

  it('a page that fails is resumed from the same cursor (O5)', async () => {
    let calls = 0
    const fetchImpl: ServerSourceFetch = async (input, init) => {
      calls++
      if (calls === 1) return new Response(null, { status: 500 })
      return createFakeServer({ events: events([1, 2, 3]) })(input, init)
    }
    const src = source({ fetchImpl })

    await expect(src.readPage(null, 10)).rejects.toThrow(ServerSourceError)

    // Retried from the SAME cursor (null) — nothing was advanced by the failure.
    const page = await src.readPage(null, 10)
    expect(page.lines.map((l) => l.position)).toEqual(['1', '2', '3'])
  })
})

describe('log-sync-server-source — what the server retains (O2)', () => {
  it('states the head and stored count from the stats route', async () => {
    const fake = createFakeServer({ events: events([1, 2, 3]) })
    const src = source({ fetchImpl: fake })
    const retention = await src.retention()
    expect(retention.head).toEqual({ known: true, value: 3 })
    expect(retention.storedCount).toEqual({ known: true, value: 3 })
    expect(retention.gap).toEqual({ known: true, value: 0 })
  })

  it('a stored count below the head is reported as a gap, never a deletion (O6)', async () => {
    const fake = createFakeServer({ events: events([1, 2, 3, 4, 5]), statsEventsOverride: 3 })
    const src = source({ fetchImpl: fake })
    const retention = await src.retention()
    expect(retention.head).toEqual({ known: true, value: 5 })
    expect(retention.storedCount).toEqual({ known: true, value: 3 })
    expect(retention.gap).toEqual({ known: true, value: 2 })
  })
})

describe('log-sync-server-source — the bounded look-back read (O3)', () => {
  it('reads the span of positions immediately before the cursor, with the same route', async () => {
    const requests: string[] = []
    const fake = createFakeServer({ events: events([1, 2, 3, 4, 5, 6, 7, 8]), requests })
    const src = source({ fetchImpl: fake })
    const page = await src.lookback('8', 3)
    expect(page.lines.map((l) => l.position)).toEqual(['6', '7', '8'])
    expect(requests[0]).toContain('/events?')
    expect(requests[0]).toContain('after=5')
    expect(requests[0]).toContain('limit=3')
  })

  it('clamps the look-back start at zero rather than going negative', async () => {
    const fake = createFakeServer({ events: events([1, 2]) })
    const src = source({ fetchImpl: fake })
    const page = await src.lookback('2', 50)
    expect(page.lines.map((l) => l.position)).toEqual(['1', '2'])
  })

  it('reports how many rows it has read in total across readPage and lookback (O3)', async () => {
    const fake = createFakeServer({ events: events([1, 2, 3, 4, 5]) })
    const src = source({ fetchImpl: fake })
    expect(src.rowsRead()).toBe(0)
    await src.readPage(null, 2)
    expect(src.rowsRead()).toBe(2)
    await src.lookback('5', 2)
    expect(src.rowsRead()).toBe(4)
  })
})

describe('log-sync-server-source — the rejected-lines diagnostic (O4)', () => {
  it('reports reasons and counts from the rejected route', async () => {
    const fake = createFakeServer({
      events: [],
      rejected: {
        window: 1000,
        reasons: [{ reason: 'invalid:bad_schema', count: 4 }],
        recent: [{ id: 1, received_at: 1700000000000, reason: 'invalid:bad_schema', line: '{"bad":true}' }]
      }
    })
    const src = source({ fetchImpl: fake })
    const diagnostic = await src.rejected()
    expect(diagnostic).toEqual({
      available: true,
      window: 1000,
      reasons: [{ reason: 'invalid:bad_schema', count: 4 }],
      recent: [{ id: 1, receivedAt: 1700000000000, reason: 'invalid:bad_schema', line: '{"bad":true}' }]
    })
  })

  it('a missing rejected route (404, an older server) is unavailable, never zero lost (O6, Traps)', async () => {
    const fake = createFakeServer({ events: [], rejected: 'missing' })
    const src = source({ fetchImpl: fake })
    const diagnostic = await src.rejected()
    expect(diagnostic.available).toBe(false)
    if (!diagnostic.available) {
      expect(diagnostic.reason).toContain('no rejected route')
      expect(diagnostic.reason).not.toContain('0')
    }
  })
})

describe('log-sync-server-source — credential and failure handling never prints a value (O5, O6)', () => {
  it('a credential missing from this environment never reaches the network, and names the variable', async () => {
    let called = false
    const fetchImpl: ServerSourceFetch = async () => {
      called = true
      return new Response(null, { status: 200 })
    }
    const src = source({ fetchImpl, env: {} }) // LOG_READ_TOKEN unset
    await expect(src.readPage(null, 10)).rejects.toThrow(ServerSourceError)
    expect(called).toBe(false)

    try {
      await src.readPage(null, 10)
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ServerSourceError)
      expect((err as ServerSourceError).kind).toBe('credential')
      expect((err as Error).message).toContain('LOG_READ_TOKEN')
    }
  })

  it('a server-refused credential (401) also names the variable, never a value (O6: a refused read credential)', async () => {
    const fake = createFakeServer({ events: events([1]), readToken: 'a-different-token-entirely' })
    const src = source({ fetchImpl: fake, env: { LOG_READ_TOKEN: READ_TOKEN } })
    try {
      await src.readPage(null, 10)
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ServerSourceError)
      expect((err as ServerSourceError).kind).toBe('credential')
      const message = (err as Error).message
      expect(message).toContain('LOG_READ_TOKEN')
      expect(message).not.toContain(READ_TOKEN)
      expect(message).not.toContain('a-different-token-entirely')
    }
  })

  it('retention() and rejected() never throw on a refused credential — they report it', async () => {
    const fake = createFakeServer({ events: events([1]), readToken: 'a-different-token-entirely' })
    const src = source({ fetchImpl: fake })
    const retention = await src.retention()
    expect(retention.head).toEqual({ known: false, reason: expect.stringContaining('LOG_READ_TOKEN') })
    const diagnostic = await src.rejected()
    expect(diagnostic.available).toBe(false)
    if (!diagnostic.available) expect(diagnostic.reason).toContain('LOG_READ_TOKEN')
  })

  it('never prints the credential value anywhere, success or failure', async () => {
    const fake = createFakeServer({ events: events([1, 2]) })
    const src = source({ fetchImpl: fake })
    const page = await src.readPage(null, 10)
    expect(JSON.stringify(page)).not.toContain(READ_TOKEN)
    const retention = await src.retention()
    expect(JSON.stringify(retention)).not.toContain(READ_TOKEN)
  })

  it('an unreachable server fails the page with a resumable reason (O5)', async () => {
    const fetchImpl: ServerSourceFetch = async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    }
    const src = source({ fetchImpl })
    try {
      await src.readPage(null, 10)
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ServerSourceError)
      expect((err as ServerSourceError).kind).toBe('unreachable')
    }
  })

  it('a timeout fails the page with a resumable reason, distinct from unreachable (O5)', async () => {
    const fetchImpl: ServerSourceFetch = async () => {
      const err = new Error('The operation timed out.')
      err.name = 'TimeoutError'
      throw err
    }
    const src = source({ fetchImpl })
    try {
      await src.readPage(null, 10)
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ServerSourceError)
      expect((err as ServerSourceError).kind).toBe('timeout')
    }
  })

  it('a server error (5xx) fails the page with a resumable reason, distinct from a credential refusal (O5)', async () => {
    const fetchImpl: ServerSourceFetch = async () => new Response(null, { status: 503 })
    const src = source({ fetchImpl })
    try {
      await src.readPage(null, 10)
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ServerSourceError)
      expect((err as ServerSourceError).kind).toBe('server-error')
      expect((err as Error).message).toContain('503')
    }
  })
})
