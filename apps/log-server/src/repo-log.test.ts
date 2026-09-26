/**
 * `RepoLog`'s own behaviour — ingest, deduplication, classification, paging
 * and stats (`apps/log-server/specs/server.md` §§ 3–5).
 *
 * Every request goes through `SELF`: the real Worker, in the real Workers
 * runtime, in front of a real SQLite-backed Durable Object created from this
 * package's own `wrangler.jsonc`. Nothing here stands in for the runtime, so
 * what these tests prove is what a deployed copy does.
 *
 * Each test asks `freshRepo()` for a repository name no other test uses, and
 * so gets an empty log: one repository is one object, which is the product's
 * own isolation boundary rather than a testing device (`vitest.config.ts`
 * explains why the pool's own per-test storage isolation is off).
 */

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const INGEST = 'ingest-token-for-tests'
const READ = 'read-token-for-tests'
const BASE = 'https://log.example.com'

let repoCounter = 0

/** A repository name no earlier test has used, and therefore an empty log. */
function freshRepo(): string {
  repoCounter += 1
  return `atta-labs/repo-${repoCounter}`
}

/** A valid `schema: 2` header — the shape the sender's own storage contract produces. */
function metaV2(repo: string, seq: number, eventId: string, ts = '2026-09-14T00:00:00.000Z'): Record<string, unknown> {
  return {
    schema: 2,
    ts,
    run_id: 'run-1',
    seq,
    repo,
    vinaya: '0.32.0',
    doctrine: 'aeg-root@deadbeef',
    host: 'cli',
    machine: 'cafebabe',
    event_id: eventId,
    process_id: 'proc-1',
    actor_id: 'developer',
    lineage: { run: null, attempt: null, parent: null },
    input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
    provenance: 'env_correlated'
  }
}

/** A valid `forge_write` `refused` event — `reason` is the free-text field a secret can land in. */
function forgeWrite(meta: Record<string, unknown>, reason: string): Record<string, unknown> {
  return {
    meta,
    subject: { issue: 725, role: 'developer' },
    kind: 'forge_write',
    event: 'refused',
    payload: {},
    op: 'issue.comment',
    target: { issue: 725 },
    reason
  }
}

/** One well-formed event line for `repo`, identified `e-<n>`. */
function line(repo: string, n: number, reason = 'ok', ts?: string): string {
  return JSON.stringify(forgeWrite(metaV2(repo, n, `e-${n}`, ts), reason))
}

function url(repo: string, path: string): string {
  return `${BASE}/v1/repos/${repo}/${path}`
}

async function post(repo: string, body: string): Promise<Response> {
  return await SELF.fetch(url(repo, 'events'), {
    method: 'POST',
    headers: { authorization: `Bearer ${INGEST}`, 'content-type': 'application/x-ndjson' },
    body
  })
}

async function read(repo: string, query = ''): Promise<Response> {
  return await SELF.fetch(`${url(repo, 'events')}${query}`, { headers: { authorization: `Bearer ${READ}` } })
}

async function stats(repo: string): Promise<Response> {
  return await SELF.fetch(url(repo, 'stats'), { headers: { authorization: `Bearer ${READ}` } })
}

type PageRow = { seq: number; status: string; event: { meta: { event_id?: string }; reason?: string } }

/**
 * The NDJSON a read page returned, one parsed envelope per line. Decoded from
 * the raw bytes rather than through `.text()`, which the runtime warns about
 * once per call for any content type it does not recognise as text.
 */
async function pageBody(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer())
}

async function pageLines(response: Response): Promise<PageRow[]> {
  const text = await pageBody(response)
  if (text === '') return []
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as PageRow)
}

describe('ingest stores each new event exactly once, in arrival order', () => {
  it('stores a batch, and stores nothing new when the same batch is resent', async () => {
    const repo = freshRepo()
    const batch = [line(repo, 1), line(repo, 2)].join('\n')

    const first = await post(repo, batch)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ accepted: 2, duplicates: 0, rejected: 0, last_seq: 2 })

    const resend = await post(repo, batch)
    expect(resend.status).toBe(200)
    expect(await resend.json()).toEqual({ accepted: 0, duplicates: 2, rejected: 0, last_seq: 2 })

    expect((await pageLines(await read(repo))).map((row) => row.seq)).toEqual([1, 2])
  })

  it('counts a mixed batch as the duplicates and the new events it actually holds', async () => {
    const repo = freshRepo()
    await post(repo, [line(repo, 1), line(repo, 2)].join('\n'))

    const mixed = await post(repo, [line(repo, 2), line(repo, 3)].join('\n'))
    expect(await mixed.json()).toEqual({ accepted: 1, duplicates: 1, rejected: 0, last_seq: 3 })

    expect((await pageLines(await read(repo))).map((row) => row.seq)).toEqual([1, 2, 3])
  })

  it('keeps arrival order, not the order of the events own sequence numbers', async () => {
    const repo = freshRepo()
    await post(repo, line(repo, 9))
    await post(repo, line(repo, 4))
    await post(repo, line(repo, 7))

    const page = await pageLines(await read(repo))
    expect(page.map((row) => row.event.meta.event_id)).toEqual(['e-9', 'e-4', 'e-7'])
  })

  it('ignores blank lines, so a body ending in a newline is not a line of its own', async () => {
    const repo = freshRepo()
    const response = await post(repo, `${line(repo, 1)}\n\n${line(repo, 2)}\n`)
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 0, rejected: 0, last_seq: 2 })
  })

  it('keeps one repositorys log separate from anothers', async () => {
    const one = freshRepo()
    const other = freshRepo()
    await post(one, [line(one, 1), line(one, 2)].join('\n'))
    await post(other, line(other, 1))

    expect((await pageLines(await read(one))).length).toBe(2)
    expect((await pageLines(await read(other))).length).toBe(1)
  })

  it('reaches one log whatever the case of the repository in the path', async () => {
    const repo = freshRepo()
    await post(repo.toUpperCase(), line(repo, 1))

    const resend = await post(repo, line(repo, 1))
    expect(await resend.json()).toEqual({ accepted: 0, duplicates: 1, rejected: 0, last_seq: 1 })
  })
})

describe('no lines content makes the server refuse a request', () => {
  it('stores a line whose schema version it does not know, verbatim and marked as such', async () => {
    const repo = freshRepo()
    const future = JSON.stringify(forgeWrite({ ...metaV2(repo, 1, 'e-future'), schema: 99 }, 'from a newer sender'))

    const response = await post(repo, future)
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0, last_seq: 1 })

    const [row] = await pageLines(await read(repo))
    expect(row?.status).toBe('unknown_version')
    expect(row?.event).toEqual(JSON.parse(future))
  })

  it('answers 200 and counts the bad line, so one bad line never blocks a senders queue', async () => {
    const repo = freshRepo()
    const response = await post(repo, [line(repo, 1), 'not json at all', line(repo, 2)].join('\n'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 0, rejected: 1, last_seq: 2 })
    expect((await pageLines(await read(repo))).map((row) => row.seq)).toEqual([1, 2])
  })

  it('rejects a line with no readable identity rather than storing it', async () => {
    const repo = freshRepo()
    const identityless = JSON.stringify({ meta: { schema: 99, ts: '2026-09-14T00:00:00.000Z' }, kind: 'gate' })

    const response = await post(repo, identityless)
    expect(await response.json()).toEqual({ accepted: 0, duplicates: 0, rejected: 1, last_seq: 0 })
    expect(await pageLines(await read(repo))).toEqual([])
  })

  it('rejects a line over 1 MiB rather than storing it', async () => {
    const repo = freshRepo()
    const oversized = JSON.stringify(forgeWrite(metaV2(repo, 1, 'e-big'), 'x'.repeat(1024 * 1024 + 1)))
    expect(oversized.length).toBeGreaterThan(1024 * 1024)

    const response = await post(repo, [oversized, line(repo, 2)].join('\n'))
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 1, last_seq: 1 })

    const page = await pageLines(await read(repo))
    expect(page.map((row) => row.event.meta.event_id)).toEqual(['e-2'])
  })

  it('answers 413 for a body over 8 MiB, storing nothing', async () => {
    const repo = freshRepo()
    const response = await post(repo, 'x'.repeat(8 * 1024 * 1024 + 1))

    expect(response.status).toBe(413)
    expect(await pageLines(await read(repo))).toEqual([])
  })

  it('redacts again on arrival, so a secret the sender missed is not what gets stored', async () => {
    const repo = freshRepo()
    await post(repo, line(repo, 1, 'failed with gho_abcdefghijklmnopqrstuvwxyz0123456789'))

    const [row] = await pageLines(await read(repo))
    expect(row?.event.reason).toBe('failed with <redacted>')
  })

  it('stores the good events in a batch that also carries a duplicate', async () => {
    const repo = freshRepo()
    await post(repo, line(repo, 1))

    const response = await post(repo, [line(repo, 1), line(repo, 2)].join('\n'))
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 1, rejected: 0, last_seq: 2 })
  })
})

describe('reading a page back from any position', () => {
  it('returns events after a position, in order, with the position to continue from', async () => {
    const repo = freshRepo()
    await post(repo, [line(repo, 1), line(repo, 2), line(repo, 3)].join('\n'))

    const first = await read(repo, '?after=0&limit=2')
    expect(first.headers.get('content-type')).toBe('application/x-ndjson')
    expect(first.headers.get('vinaya-log-next-after')).toBe('2')
    expect((await pageLines(first)).map((row) => row.seq)).toEqual([1, 2])

    const second = await read(repo, '?after=2&limit=2')
    expect(second.headers.get('vinaya-log-next-after')).toBe('3')
    expect((await pageLines(second)).map((row) => row.seq)).toEqual([3])

    const caughtUp = await read(repo, '?after=3')
    expect(await pageBody(caughtUp)).toBe('')
    expect(caughtUp.headers.get('vinaya-log-next-after')).toBe('3')
  })

  it('serves at most 1,000 lines, whatever limit is asked for', async () => {
    const repo = freshRepo()
    const batch: string[] = []
    for (let n = 1; n <= 1005; n += 1) batch.push(line(repo, n))
    await post(repo, batch.join('\n'))

    const capped = await read(repo, '?limit=5000')
    expect((await pageLines(capped)).length).toBe(1000)
    expect(capped.headers.get('vinaya-log-next-after')).toBe('1000')

    expect((await pageLines(await read(repo))).length).toBe(1000)
  })

  it('refuses a position or a limit that is not a positive whole number', async () => {
    const repo = freshRepo()
    expect((await read(repo, '?after=-1')).status).toBe(400)
    expect((await read(repo, '?after=abc')).status).toBe(400)
    expect((await read(repo, '?limit=0')).status).toBe(400)
    expect((await read(repo, '?limit=2.5')).status).toBe(400)
  })
})

describe('stats make the storage ceiling visible before it is reached', () => {
  it('reports what this repository holds', async () => {
    const repo = freshRepo()
    const first = line(repo, 1, 'ok', '2026-09-14T00:00:00.000Z')
    const second = line(repo, 2, 'ok', '2026-09-15T00:00:00.000Z')
    await post(repo, [first, second].join('\n'))
    await post(repo, 'not json at all')

    const body = (await (await stats(repo)).json()) as Record<string, unknown>
    expect(body.repo).toBe(repo)
    expect(body.events).toBe(2)
    expect(body.rejected).toBe(1)
    expect(body.last_seq).toBe(2)
    expect(body.oldest_ts).toBe('2026-09-14T00:00:00.000Z')
    expect(body.newest_ts).toBe('2026-09-15T00:00:00.000Z')
    expect(body.bytes).toBeGreaterThan(0)
  })

  it('reports an empty log without inventing a time range', async () => {
    const repo = freshRepo()
    const body = (await (await stats(repo)).json()) as Record<string, unknown>
    expect(body).toMatchObject({ repo, events: 0, rejected: 0, last_seq: 0, oldest_ts: null, newest_ts: null })
  })
})

/** A live viewer's socket, with everything it has been sent and how it was closed. */
type Viewer = {
  socket: WebSocket
  messages: string[]
  closed: { code: number; reason: string } | null
}

type LiveEvent = { seq: number; status: string; event: { meta: { event_id?: string } } }

type Resync = { type: string; after: number }

/**
 * A live connection to `repo`, opened the way a viewer opens one: a WebSocket
 * upgrade carrying the feed's protocol and the read token as a second one.
 * Every message and the close frame are collected from the moment the socket
 * is accepted, so a replay the server sent during the handshake is not missed.
 */
async function openLive(repo: string, query = ''): Promise<Viewer> {
  const response = await SELF.fetch(`${url(repo, 'live')}${query}`, {
    headers: { upgrade: 'websocket', 'sec-websocket-protocol': `vinaya-log.v1, bearer.${READ}` }
  })
  expect(response.status).toBe(101)
  expect(response.headers.get('sec-websocket-protocol')).toBe('vinaya-log.v1')

  const socket = response.webSocket
  if (socket === null) throw new Error('the live route answered 101 without a socket')

  const viewer: Viewer = { socket, messages: [], closed: null }
  socket.accept()
  socket.addEventListener('message', (event) => {
    viewer.messages.push(String(event.data))
  })
  socket.addEventListener('close', (event) => {
    viewer.closed = { code: event.code, reason: event.reason }
  })
  return viewer
}

/** Wait until `viewer` has been sent at least `count` messages, or fail rather than hang. */
async function messages(viewer: Viewer, count: number): Promise<string[]> {
  const deadline = Date.now() + 5000
  while (viewer.messages.length < count && Date.now() < deadline) await settle()
  expect(viewer.messages.length).toBeGreaterThanOrEqual(count)
  return viewer.messages
}

/** Let every message already in flight arrive, so "nothing more was sent" is a real assertion. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25))
}

function liveEvents(viewer: Viewer): LiveEvent[] {
  return viewer.messages.map((message) => JSON.parse(message) as LiveEvent)
}

/** A batch of `count` well-formed events for `repo`, identified `e-1` … `e-<count>`. */
function batchOf(repo: string, count: number, from = 1): string {
  const lines: string[] = []
  for (let n = from; n < from + count; n += 1) lines.push(line(repo, n))
  return lines.join('\n')
}

describe('a live viewer receives each event the moment it is stored', () => {
  it('replays what is already stored after a position, then sends each new event as it commits', async () => {
    const repo = freshRepo()
    await post(repo, batchOf(repo, 2))

    const viewer = await openLive(repo, '?after=0')
    await messages(viewer, 2)
    await post(repo, line(repo, 3))
    await messages(viewer, 3)
    await settle()

    expect(liveEvents(viewer).map((message) => message.seq)).toEqual([1, 2, 3])
    expect(liveEvents(viewer).map((message) => message.event.meta.event_id)).toEqual(['e-1', 'e-2', 'e-3'])
    expect(liveEvents(viewer)[0]?.status).toBe('ok')
    expect(viewer.closed).toBeNull()
  })

  it('starts from the position the viewer asked for, not from the head', async () => {
    const repo = freshRepo()
    await post(repo, batchOf(repo, 3))

    const viewer = await openLive(repo, '?after=2')
    await messages(viewer, 1)
    await settle()

    expect(liveEvents(viewer).map((message) => message.seq)).toEqual([3])
  })

  it('misses no event and repeats none when an ingest commits while a viewer is connecting', async () => {
    const repo = freshRepo()
    await post(repo, batchOf(repo, 5))

    // Both requests are in flight together: the connection's catch-up query
    // and the ingest's commit race inside the one object, which is the switch
    // from catching up to live that must neither drop an event nor send one
    // twice.
    const connecting = openLive(repo, '?after=0')
    const ingesting = post(repo, batchOf(repo, 2, 6))
    const viewer = await connecting
    await ingesting

    await messages(viewer, 7)
    await settle()

    const seen = liveEvents(viewer).map((message) => message.seq)
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('says nothing to a viewer when an ingest stores only duplicates', async () => {
    const repo = freshRepo()
    await post(repo, batchOf(repo, 2))

    const viewer = await openLive(repo, '?after=2')
    await settle()
    expect(viewer.messages).toEqual([])

    const resend = await post(repo, batchOf(repo, 2))
    expect(await resend.json()).toEqual({ accepted: 0, duplicates: 2, rejected: 0, last_seq: 2 })
    await settle()
    expect(viewer.messages).toEqual([])

    await post(repo, [line(repo, 2), line(repo, 3)].join('\n'))
    await messages(viewer, 1)
    await settle()
    expect(liveEvents(viewer).map((message) => message.seq)).toEqual([3])
  })

  it('sends a viewer only its own repositorys events', async () => {
    const repo = freshRepo()
    const other = freshRepo()

    const viewer = await openLive(repo)
    await post(other, batchOf(other, 2))
    await settle()

    expect(viewer.messages).toEqual([])
  })

  it('refuses a position that is not a whole number rather than opening a socket', async () => {
    const repo = freshRepo()
    const response = await SELF.fetch(`${url(repo, 'live')}?after=-1`, {
      headers: { upgrade: 'websocket', 'sec-websocket-protocol': `vinaya-log.v1, bearer.${READ}` }
    })

    expect(response.status).toBe(400)
    expect(response.webSocket).toBeNull()
  })
})

describe('a viewer too far behind is told where to page from instead of being replayed', () => {
  it('sends one resync naming the position to page from, and closes', async () => {
    const repo = freshRepo()
    await post(repo, batchOf(repo, 1001))

    const viewer = await openLive(repo, '?after=0')
    await messages(viewer, 1)
    await settle()

    expect(viewer.messages.length).toBe(1)
    expect(JSON.parse(viewer.messages[0] as string) as Resync).toEqual({ type: 'resync', after: 0 })
    expect(viewer.closed?.code).toBe(1013)
  })

  it('catches a viewer up over the socket when it is exactly one page behind', async () => {
    const repo = freshRepo()
    await post(repo, batchOf(repo, 1001))

    const viewer = await openLive(repo, '?after=1')
    await messages(viewer, 1000)
    await settle()

    const seen = liveEvents(viewer).map((message) => message.seq)
    expect(seen.length).toBe(1000)
    expect(seen[0]).toBe(2)
    expect(seen[999]).toBe(1001)
    expect(viewer.closed).toBeNull()
  })
})
