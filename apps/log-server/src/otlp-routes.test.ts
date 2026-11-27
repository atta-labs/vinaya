/**
 * The OpenTelemetry routes end to end (`apps/log-server/specs/server.md` § 5, "OpenTelemetry"): the two ingest
 * routes the Log SDK's sender posts to, the records read route, their tokens and statuses, and that today's event
 * routes answer exactly as before beside them.
 *
 * Every request goes through `SELF`, the real Worker in the real Workers runtime in front of a real SQLite-backed
 * Durable Object. The export requests are the ones the Log SDK's own sender posted for a recorded run, captured in
 * `fixtures/sdk-export.json` (kept matching the sender by the SDK's `tests/sender-capture.test.ts`); a refused record
 * is made by changing one field of a captured one. Each test uses a repository name no other test uses.
 */

import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import fixture from './fixtures/sdk-export.json'
import type { Env, RepoLog } from './repo-log'

const INGEST = 'ingest-token-for-tests'
const READ = 'read-token-for-tests'
const BASE = 'https://log.example.com'

type Json = Record<string, any>
type Export = { path: string; contentType: string; body: Json }

let counter = 0

/** A repository name no other test uses, and therefore an empty log. */
function freshRepo(): string {
  counter += 1
  return `atta-labs/otlp-routes-${counter}`
}

/** The captured request's path under `repo`: the sender posted under `/v1/repos/acme/widgets/otlp`. */
function pathFor(repo: string, captured: string): string {
  return captured.replace('/v1/repos/acme/widgets/', `/v1/repos/${repo}/`)
}

/** Post every captured export request to `repo`, in the order the sender's run wrote them. */
async function postAll(repo: string, exports: readonly Export[] = fixture.exports as Export[]): Promise<Response[]> {
  const responses: Response[] = []
  for (const entry of exports) {
    responses.push(
      await SELF.fetch(`${BASE}${pathFor(repo, entry.path)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INGEST}`, 'content-type': entry.contentType },
        body: JSON.stringify(entry.body)
      })
    )
  }
  return responses
}

async function readRecords(repo: string, query = ''): Promise<{ response: Response; lines: Json[] }> {
  const response = await SELF.fetch(`${BASE}/v1/repos/${repo}/otlp/records${query}`, {
    headers: { authorization: `Bearer ${READ}` }
  })
  const text = await response.text()
  const lines = text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Json)
  return { response, lines }
}

function recordOf(line: Json): Json {
  const document = line.record
  return line.kind === 'span'
    ? document.resourceSpans[0].scopeSpans[0].spans[0]
    : document.resourceLogs[0].scopeLogs[0].logRecords[0]
}

function capturedRecord(entry: Export): Json {
  return entry.body.resourceSpans
    ? entry.body.resourceSpans[0].scopeSpans[0].spans[0]
    : entry.body.resourceLogs[0].scopeLogs[0].logRecords[0]
}

describe('the ingest routes store each captured record once', () => {
  it('answers each captured request 200 with an export response that has no partial success', async () => {
    const repo = freshRepo()
    for (const response of await postAll(repo)) {
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({})
      expect(response.headers.get('vinaya-log-stored')).toBe('1')
      expect(response.headers.get('vinaya-log-duplicates')).toBe('0')
    }
    const { lines } = await readRecords(repo)
    expect(lines.map((line) => line.seq)).toEqual(fixture.exports.map((_, index) => index + 1))
    expect(lines.map((line) => recordOf(line))).toEqual((fixture.exports as Export[]).map(capturedRecord))
  })

  it('stores nothing new for a resent request and counts its records as duplicates', async () => {
    const repo = freshRepo()
    await postAll(repo)
    for (const response of await postAll(repo)) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({})
      expect(response.headers.get('vinaya-log-stored')).toBe('0')
      expect(response.headers.get('vinaya-log-duplicates')).toBe('1')
    }
    const { lines } = await readRecords(repo)
    expect(lines).toHaveLength(fixture.exports.length)
  })

  it('stores the rest of a request and answers a partial success for its refused records, kept with their reason', async () => {
    const repo = freshRepo()
    const captured = (fixture.exports as Export[]).find((entry) => entry.path.endsWith('/v1/logs')) as Export
    const body = structuredClone(captured.body)
    const records = body.resourceLogs[0].scopeLogs[0].logRecords
    const unknown = structuredClone(records[0])
    unknown.eventName = 'vinaya.not.in.the.catalogue'
    records.push(unknown)

    const [response] = await postAll(repo, [{ ...captured, body }])
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({
      partialSuccess: {
        rejectedLogRecords: '1',
        errorMessage: expect.stringContaining('event name "vinaya.not.in.the.catalogue"')
      }
    })
    expect(response?.headers.get('vinaya-log-stored')).toBe('1')
    expect(response?.headers.get('vinaya-log-refused')).toBe('1')

    expect((await readRecords(repo)).lines).toHaveLength(1)
    const kept = await runInDurableObject(stubFor(repo), (_instance: RepoLog, state) =>
      state.storage.sql
        .exec<{ kind: string; reason: string; line: string }>('SELECT kind, reason, line FROM otlp_rejected')
        .toArray()
    )
    expect(kept).toHaveLength(1)
    expect(kept[0]?.kind).toBe('log')
    expect(kept[0]?.reason).toContain('vinaya.not.in.the.catalogue')
    expect(kept[0]?.line).toContain('vinaya.not.in.the.catalogue')
  })
})

describe('the records route pages OpenTelemetry records', () => {
  it('pages in arrival order from any position, with the next position in vinaya-log-next-after', async () => {
    const repo = freshRepo()
    await postAll(repo)
    const total = fixture.exports.length

    const first = await readRecords(repo, '?limit=3')
    expect(first.lines.map((line) => line.seq)).toEqual([1, 2, 3])
    expect(first.response.headers.get('vinaya-log-next-after')).toBe('3')
    expect(first.response.headers.get('content-type')).toBe('application/x-ndjson')

    const rest = await readRecords(repo, '?after=3')
    expect(rest.lines.map((line) => line.seq)).toEqual(Array.from({ length: total - 3 }, (_, index) => index + 4))
    expect(rest.response.headers.get('vinaya-log-next-after')).toBe(String(total))

    const caughtUp = await readRecords(repo, `?after=${total}`)
    expect(caughtUp.lines).toEqual([])
    expect(caughtUp.response.headers.get('vinaya-log-next-after')).toBe(String(total))

    for (const line of first.lines) expect(['span', 'log']).toContain(line.kind)
  })

  it('returns only one run’s records when asked for one run', async () => {
    const repo = freshRepo()
    await postAll(repo)
    // A second run's records: the captured requests with another trace, as another run's writer would send them.
    const other = (fixture.exports as Export[]).map((entry) => {
      const body = structuredClone(entry.body)
      capturedRecord({ ...entry, body }).traceId = 'f'.repeat(32)
      return { ...entry, body }
    })
    await postAll(repo, other)
    expect((await readRecords(repo)).lines).toHaveLength(fixture.exports.length * 2)

    const run = await readRecords(repo, `?run=${encodeURIComponent(fixture.runId)}`)
    expect(run.lines.map((line) => line.seq)).toEqual(fixture.exports.map((_, index) => index + 1))
    expect((await readRecords(repo, '?run=another-run')).lines).toEqual([])
  })

  it('refuses a malformed position, limit or run with 400', async () => {
    const repo = freshRepo()
    expect((await readRecords(repo, '?after=-1')).response.status).toBe(400)
    expect((await readRecords(repo, '?limit=0')).response.status).toBe(400)
    expect((await readRecords(repo, '?run=')).response.status).toBe(400)
  })
})

describe('tokens, content type and size', () => {
  const traces = (fixture.exports as Export[]).find((entry) => entry.path.endsWith('/v1/traces')) as Export

  it('takes the ingest token on the two ingest routes and the read token on the records route, and nothing else', async () => {
    const repo = freshRepo()
    for (const signal of ['traces', 'logs']) {
      for (const authorization of [`Bearer ${READ}`, 'Bearer wrong', undefined]) {
        const response = await SELF.fetch(`${BASE}/v1/repos/${repo}/otlp/v1/${signal}`, {
          method: 'POST',
          // Wrong on every count but the token: the token is checked first.
          headers: { 'content-type': 'text/plain', ...(authorization ? { authorization } : {}) },
          body: 'not json'
        })
        expect(response.status).toBe(401)
      }
    }
    for (const authorization of [`Bearer ${INGEST}`, 'Bearer wrong']) {
      const response = await SELF.fetch(`${BASE}/v1/repos/${repo}/otlp/records`, { headers: { authorization } })
      expect(response.status).toBe(401)
    }
  })

  it('answers 415 for a body that is not OTLP JSON, 400 for one that does not parse, and 413 for one over 8 MiB', async () => {
    const repo = freshRepo()
    const post = (headers: Record<string, string>, body: string) =>
      SELF.fetch(`${BASE}${pathFor(repo, traces.path)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INGEST}`, ...headers },
        body
      })
    expect((await post({ 'content-type': 'application/x-protobuf' }, JSON.stringify(traces.body))).status).toBe(415)
    expect((await post({}, JSON.stringify(traces.body))).status).toBe(415)
    expect((await post({ 'content-type': 'application/json' }, '{"resourceSpans":')).status).toBe(400)
    const oversized = JSON.stringify({ ...traces.body, padding: 'a'.repeat(8 * 1024 * 1024) })
    expect((await post({ 'content-type': 'application/json' }, oversized)).status).toBe(413)
    expect((await readRecords(repo)).lines).toEqual([])
  })

  it('answers 405 for a wrong method and 400 for a malformed repository', async () => {
    const get = await SELF.fetch(`${BASE}/v1/repos/atta-labs/otlp-method/otlp/v1/traces`, {
      headers: { authorization: `Bearer ${INGEST}` }
    })
    expect(get.status).toBe(405)
    const post = await SELF.fetch(`${BASE}/v1/repos/atta-labs/otlp-method/otlp/records`, {
      method: 'POST',
      headers: { authorization: `Bearer ${READ}` }
    })
    expect(post.status).toBe(405)
    const bad = await SELF.fetch(`${BASE}/v1/repos/atta labs/x/otlp/records`, {
      headers: { authorization: `Bearer ${READ}` }
    })
    expect(bad.status).toBe(400)
    const unknown = await SELF.fetch(`${BASE}/v1/repos/atta-labs/x/otlp/v1/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST}` }
    })
    expect(unknown.status).toBe(404)
  })
})

function stubFor(repo: string): DurableObjectStub<RepoLog> {
  const namespace = (env as unknown as Env).REPO_LOG
  return namespace.get(namespace.idFromName(repo.toLowerCase()))
}

/** One valid `schema: 2` event line, the shape the events ingest stores. */
function eventLine(repo: string, n: number): string {
  return JSON.stringify({
    meta: {
      schema: 2,
      ts: '2026-11-27T00:00:00.000Z',
      run_id: 'run-1',
      seq: n,
      repo,
      vinaya: '0.32.0',
      doctrine: 'doctrine@deadbeef',
      host: 'cli',
      machine: 'cafebabe',
      event_id: `otlp-beside-${n}`,
      process_id: 'proc-1',
      actor_id: 'developer',
      lineage: { run: null, attempt: null, parent: null },
      input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
      provenance: 'env_correlated'
    },
    subject: { issue: 725, role: 'developer' },
    kind: 'forge_write',
    event: 'refused',
    payload: {},
    op: 'issue.comment',
    target: { issue: 725 },
    reason: 'ok'
  })
}

describe("today's routes answer exactly as before beside the OpenTelemetry records", () => {
  it('keeps the events read, stats, rejected and live answers byte for byte, and never sends a record on them', async () => {
    const repo = freshRepo()
    const ingest = await SELF.fetch(`${BASE}/v1/repos/${repo}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST}`, 'content-type': 'application/x-ndjson' },
      body: [eventLine(repo, 1), eventLine(repo, 2), 'not json'].join('\n')
    })
    expect(await ingest.json()).toEqual({ accepted: 2, duplicates: 0, rejected: 1, last_seq: 2 })

    const read = async (path: string) => {
      const response = await SELF.fetch(`${BASE}/v1/repos/${repo}/${path}`, {
        headers: { authorization: `Bearer ${READ}` }
      })
      return {
        status: response.status,
        next: response.headers.get('vinaya-log-next-after'),
        body: await response.text()
      }
    }
    const stable = async () => {
      const stats = JSON.parse((await read('stats')).body)
      delete stats.bytes // the database's size grows with any table's rows; every other field is compared
      return {
        events: await read('events'),
        page: await read('events?after=1'),
        stats,
        rejected: await read('rejected')
      }
    }
    const before = await stable()

    const viewer = await SELF.fetch(`${BASE}/v1/repos/${repo}/live`, {
      headers: { upgrade: 'websocket', 'sec-websocket-protocol': `vinaya-log.v1, bearer.${READ}` }
    })
    const socket = viewer.webSocket
    if (socket === null) throw new Error('the live route answered without a socket')
    const messages: string[] = []
    socket.accept()
    socket.addEventListener('message', (event) => messages.push(String(event.data)))

    const refusedBody = structuredClone((fixture.exports as Export[])[0]?.body as Json)
    refusedBody.resourceLogs[0].scopeLogs[0].logRecords[0].eventName = 'vinaya.not.in.the.catalogue'
    await postAll(repo)
    await postAll(repo, [{ ...(fixture.exports[0] as Export), body: refusedBody }])
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await stable()).toEqual(before)
    expect(messages.map((message) => JSON.parse(message).seq)).toEqual([1, 2])
    socket.close(1000)

    const counts = await runInDurableObject(stubFor(repo), (_instance: RepoLog, state) => ({
      events: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events').one().n,
      rejected: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM rejected').one().n,
      records: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM otlp_records').one().n,
      refused: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM otlp_rejected').one().n
    }))
    expect(counts).toEqual({ events: 2, rejected: 1, records: fixture.exports.length, refused: 1 })
  })
})
