/**
 * `drainOutboxToWebhook` end to end (`../../src/lib/log-webhook-drain.ts`)
 * — the one delivery mechanism a `logs.url` server destination uses — against
 * a real local HTTP server instead of a stubbed `gh`. Each call runs in its
 * own `bun` subprocess, never an in-process import: `GLOBAL_VINAYA_HOME`
 * (`../../src/lib/config.ts`) is a module-level constant frozen at first
 * import, so `HOME` must be set before that module is ever loaded — the same
 * discipline every other test here that touches a real outbox follows.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOK_DRAIN_LOCK_STALE_MS,
  acquireDrainLock,
  releaseDrainLock
} from '../../src/lib/log-webhook-drain.js'
import { OUTBOX_MAX_BYTES } from '../../src/lib/log-sink.js'
import { spawnBudgetedAsync, spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DRAIN_MODULE = join(CLI_ROOT, 'src', 'lib', 'log-webhook-drain.ts')
const OWNER_REPO_DIR = 'test-owner-test-repo'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:test-owner/test-repo.git'], { cwd })
}

function outboxPath(home: string, issue: number): string {
  return join(home, '.vinaya', 'outbox', OWNER_REPO_DIR, `${issue}.ndjson`)
}

function ndjsonLine(runId: string, issue: number): string {
  return JSON.stringify({
    meta: {
      schema: 1,
      ts: '2026-09-16T00:00:00.000Z',
      run_id: runId,
      seq: 0,
      repo: null,
      vinaya: '0.0.0',
      doctrine: 'unknown',
      host: 'cli',
      machine: 'deadbeef'
    },
    subject: { issue, role: 'developer' },
    kind: 'forge_write',
    event: 'validated',
    payload: {},
    op: 'issue.comment',
    target: { issue }
  })
}

/**
 * A fully valid line padded to roughly `bytes` through `forge_write`'s own
 * free-string `reason` field — the only way to build a queue that genuinely
 * crosses `MAX_WEBHOOK_BODY_BYTES` without the padding itself making the line
 * invalid (which would prove the rejection path, not the chunking one).
 */
function paddedNdjsonLine(runId: string, issue: number, bytes: number): string {
  return JSON.stringify({
    meta: {
      schema: 1,
      ts: '2026-09-16T00:00:00.000Z',
      run_id: runId,
      seq: 0,
      repo: null,
      vinaya: '0.0.0',
      doctrine: 'unknown',
      host: 'cli',
      machine: 'deadbeef'
    },
    subject: { issue, role: 'developer' },
    kind: 'forge_write',
    event: 'refused',
    reason: 'x'.repeat(bytes),
    payload: {},
    op: 'issue.comment',
    target: { issue }
  })
}

/** A line whose `meta.schema` is outside `KNOWN_SCHEMA_VERSIONS` — a real event from a newer producer, which this build must keep rather than post or drop. */
function unknownVersionLine(runId: string, issue: number): string {
  const parsed = JSON.parse(ndjsonLine(runId, issue)) as { meta: { schema: number } }
  parsed.meta.schema = 99
  return JSON.stringify(parsed)
}

function runIdsOf(body: string): string[] {
  return body
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).meta.run_id as string)
}

function rejectedRecords(home: string, issue: number): { status: string; reason: string; raw: string }[] {
  const p = outboxPath(home, issue).replace(/\.ndjson$/, '.rejected.ndjson')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** What the queue holds — a drain that empties a bucket removes its file outright, so "nothing queued" is a missing file just as legitimately as an empty one. */
function queueContent(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function seedOutbox(home: string, issue: number, lines: string[]): string {
  const p = outboxPath(home, issue)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${lines.join('\n')}\n`)
  return p
}

type CapturedRequest = { body: string; headers: Record<string, string> }

/** A throwaway HTTP server standing in for a customer's log-ingest endpoint — every request is captured, and `status` controls what it answers with. */
function startWebhookServer(status = 200): {
  url: string
  requests: CapturedRequest[]
  stop: () => void
} {
  const requests: CapturedRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        headers[k] = v
      })
      requests.push({ body, headers })
      return new Response(status === 200 ? 'ok' : 'error', { status })
    }
  })
  return { url: `http://127.0.0.1:${server.port}/ingest`, requests, stop: () => server.stop() }
}

/** Like `startWebhookServer`, but answers request `i` with `statuses[i]` (the last value repeating) — how a drain that fails PART-WAY through a backlog is staged, rather than failing on its very first POST. */
function startSequencedWebhookServer(statuses: number[]): {
  url: string
  requests: CapturedRequest[]
  stop: () => void
} {
  const requests: CapturedRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        headers[k] = v
      })
      const status = statuses[requests.length] ?? (statuses[statuses.length - 1] as number)
      requests.push({ body, headers })
      return new Response(status < 300 ? 'ok' : 'error', { status })
    }
  })
  return { url: `http://127.0.0.1:${server.port}/ingest`, requests, stop: () => server.stop() }
}

/**
 * Accepts every request but holds the FIRST one past the client's own fetch
 * timeout — the lost-acknowledgement shape: the server took the chunk, the
 * client never learned it did.
 */
function startLostAcknowledgementServer(firstDelayMs: number): {
  url: string
  requests: CapturedRequest[]
  stop: () => void
} {
  const requests: CapturedRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        headers[k] = v
      })
      const first = requests.length === 0
      requests.push({ body, headers })
      if (first) await new Promise((r) => setTimeout(r, firstDelayMs))
      return new Response('ok', { status: 200 })
    }
  })
  return { url: `http://127.0.0.1:${server.port}/ingest`, requests, stop: () => server.stop() }
}

/** Like `startWebhookServer`, but holds the response for `delayMs` — long enough for a concurrently-run second drain to observe the first's lock still held. */
function startSlowWebhookServer(
  status: number,
  delayMs: number
): { url: string; requests: CapturedRequest[]; stop: () => void } {
  const requests: CapturedRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        headers[k] = v
      })
      requests.push({ body, headers })
      await new Promise((r) => setTimeout(r, delayMs))
      return new Response(status === 200 ? 'ok' : 'error', { status })
    }
  })
  return { url: `http://127.0.0.1:${server.port}/ingest`, requests, stop: () => server.stop() }
}

type DrainOutcome = { flushed: boolean; lineCount: number; bytes: number; chunks: number; rejected: number }
type DrainResult = { ok: true; outcome: DrainOutcome } | { ok: false; code: string | null; message: string }

/** Nothing moved: an empty or missing queue, or a caller that lost the cross-process lock. */
const NOTHING_DRAINED: DrainOutcome = { flushed: false, lineCount: 0, bytes: 0, chunks: 0, rejected: 0 }

/** Writes a tiny script importing `drainOutboxToWebhook` directly and running it once, so this test never depends on any CLI argv surface for a function that is no longer reachable from one. */
function writeDrainScript(
  scriptPath: string,
  issue: number,
  url: string,
  headers: Record<string, string> | undefined,
  fetchTimeoutMs?: number
): void {
  writeFileSync(
    scriptPath,
    `import { drainOutboxToWebhook, WebhookDrainError } from ${JSON.stringify(DRAIN_MODULE)}
    try {
      const outcome = await drainOutboxToWebhook(${issue}, ${JSON.stringify(url)}, ${headers ? JSON.stringify(headers) : 'undefined'}${fetchTimeoutMs !== undefined ? `, ${fetchTimeoutMs}` : ''})
      console.log(JSON.stringify({ ok: true, outcome }))
    } catch (err) {
      console.log(JSON.stringify({ ok: false, code: err instanceof WebhookDrainError ? err.code : null, message: err instanceof Error ? err.message : String(err) }))
    }`
  )
}

function parseDrainOutput(stdout: string): DrainResult {
  return JSON.parse(stdout.trim().split('\n').pop() as string)
}

// Async launch: the child's own POST can land on THIS process's `Bun.serve()`
// server — a synchronous spawn here would block the one thread that server's
// `fetch` handler also needs to run on, and on Bun 1.4.2 (a genuinely
// blocking synchronous spawn) the request would never be answered at all.
async function runDrainAsyncCaptured(
  issue: number,
  url: string,
  headers: Record<string, string> | undefined,
  cwd: string,
  home: string,
  fetchTimeoutMs?: number,
  budgetMs = 6000
): Promise<{ result: DrainResult; stderr: string }> {
  // One script per call, never per issue: a test that drains the same queue
  // twice would otherwise have its second call overwrite the first's script
  // while that process is still reading it.
  const script = join(cwd, `run-drain-${issue}-${randomUUID()}.ts`)
  writeDrainScript(script, issue, url, headers, fetchTimeoutMs)
  const r = await spawnBudgetedAsync(
    ['bun', script],
    { cwd, env: { ...stripVinayaEnv(), HOME: home } },
    budgetMs,
    'drainOutboxToWebhook (async)'
  )
  return { result: parseDrainOutput(r.stdout), stderr: r.stderr }
}

async function runDrainAsync(
  issue: number,
  url: string,
  headers: Record<string, string> | undefined,
  cwd: string,
  home: string
): Promise<DrainResult> {
  return (await runDrainAsyncCaptured(issue, url, headers, cwd, home)).result
}

describe('drainOutboxToWebhook — the logs.url server-destination delivery path', () => {
  it('POSTs the outbox as ndjson, with configured headers, and truncates on 2xx', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const lines = [ndjsonLine('run-1', 700), ndjsonLine('run-2', 700)]
    const path = seedOutbox(home, 700, lines)

    const result = await runDrainAsync(700, server.url, { 'x-api-key': 'secret123' }, cwd, home)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 2, bytes: expect.any(Number), chunks: 1, rejected: 0 })
    expect(server.requests.length).toBe(1)
    expect(server.requests[0]?.headers['x-api-key']).toBe('secret123')
    expect(server.requests[0]?.headers['content-type']).toBe('application/x-ndjson')
    const posted = server.requests[0]?.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).meta.run_id)
    expect(posted).toEqual(['run-1', 'run-2'])

    expect(queueContent(path)).toBe('')
  })

  it('keeps every unacknowledged line queued, and delivers it on the next drain, when the webhook does not answer 2xx', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(500)
    const line = ndjsonLine('run-1', 701)
    const path = seedOutbox(home, 701, [line])

    const result = await runDrainAsync(701, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('log-webhook-drain-failed')
    // The bucket being drained is held under its own private name, out of
    // reach of the producer's own appends and rotation, so what the server
    // refused waits there rather than at the live path.
    expect(readFileSync(siblingPath(home, 701, '.draining.ndjson'), 'utf8')).toBe(`${line}\n`)

    const accepting = startWebhookServer(200)
    const retry = await runDrainAsync(701, accepting.url, undefined, cwd, home)
    accepting.stop()

    expect(retry.ok).toBe(true)
    expect(accepting.requests.map((r) => runIdsOf(r.body))).toEqual([['run-1']])
    expect(queueContent(path)).toBe('')
    expect(existsSync(siblingPath(home, 701, '.draining.ndjson'))).toBe(false)
  }, 20000)

  it('posts nothing at all when the only queued line is corrupt — it is set aside, never sent', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const path = seedOutbox(home, 702, ['not valid json'])

    const result = await runDrainAsync(702, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 0, bytes: 0, chunks: 0, rejected: 1 })
    expect(server.requests.length).toBe(0)
    expect(queueContent(path)).toBe('')
    expect(rejectedRecords(home, 702).map((r) => [r.status, r.raw])).toEqual([['invalid', 'not valid json']])
  })

  it('round-2 security review, MEDIUM: bounds the POST — a slow/unresponsive endpoint fails fast rather than hanging the drain indefinitely, and the outbox stays untouched', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const line = ndjsonLine('run-1', 704)
    const path = seedOutbox(home, 704, [line])

    // Never responds — proves the timeout, not the endpoint, ends this call.
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return new Promise(() => {})
      }
    })

    // A short test-only `fetchTimeoutMs` override (this file's own 4th
    // argument to `drainOutboxToWebhook`, never reachable from any real
    // caller) means this test never pays the real 30s production bound.
    const script = join(cwd, 'run-drain-704.ts')
    writeDrainScript(script, 704, `http://127.0.0.1:${server.port}/ingest`, undefined, 200)
    const scriptResult = spawnSyncBudgeted(
      'bun',
      [script],
      { encoding: 'utf8', cwd, env: { ...stripVinayaEnv(), HOME: home } },
      undefined,
      'run-drain-704.ts'
    )
    server.stop(true)

    const result = parseDrainOutput(scriptResult.stdout)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('log-webhook-drain-failed')
    expect(result.message).toContain('timed out after 200ms')
    expect(readFileSync(siblingPath(home, 704, '.draining.ndjson'), 'utf8')).toBe(`${line}\n`)
    expect(queueContent(path)).toBe('')
  }, 10000)

  it('reports nothing to flush for a missing outbox, without contacting the webhook', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)

    const result = await runDrainAsync(703, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual(NOTHING_DRAINED)
    expect(server.requests.length).toBe(0)
  })

  it('round-2 security review, BLOCKER: two concurrent processes never race the same queue file — the loser backs off untouched instead of double-posting or dropping a line', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startSlowWebhookServer(200, 500)
    const lines = [ndjsonLine('run-1', 705), ndjsonLine('run-2', 705)]
    const path = seedOutbox(home, 705, lines)

    const first = runDrainAsync(705, server.url, undefined, cwd, home)
    // Gives the first process time to win the lock and enter its (slow) POST
    // before the second even starts — the second must find the lock already
    // held for the whole window, not race to create it first.
    await new Promise((r) => setTimeout(r, 150))
    const second = runDrainAsync(705, server.url, undefined, cwd, home)

    const [r1, r2] = await Promise.all([first, second])
    server.stop()

    const results = [r1, r2]
    const winner = results.find((r) => r.ok && r.outcome.flushed)
    const loser = results.find((r) => r.ok && !r.outcome.flushed)

    expect(server.requests.length).toBe(1)
    expect(winner?.ok && winner.outcome).toEqual({
      flushed: true,
      lineCount: 2,
      bytes: expect.any(Number),
      chunks: 1,
      rejected: 0
    })
    expect(loser).toBeDefined()
    expect(queueContent(path)).toBe('')
  }, 10000)

  it('round-2 security review, BLOCKER: a lock abandoned by a crashed holder is stolen once stale, not left to jam every future drain', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const line = ndjsonLine('run-1', 706)
    const path = seedOutbox(home, 706, [line])
    const lockPath = `${path}.flush-lock`
    writeFileSync(lockPath, '999999\n')
    const staleMtime = new Date(Date.now() - WEBHOOK_DRAIN_LOCK_STALE_MS - 5000)
    utimesSync(lockPath, staleMtime, staleMtime)

    const result = await runDrainAsync(706, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 1, bytes: expect.any(Number), chunks: 1, rejected: 0 })
    expect(queueContent(path)).toBe('')
  })

  it('round-3 security review, MEDIUM: releaseDrainLock never deletes a lock another process now owns — a holder stalled past the stale window, then resumed, cannot tear down the lock its own lock was stolen from', () => {
    const home = tempDir('log-webhook-home-')
    const lockPath = join(home, 'some-task.flush-lock')
    mkdirSync(dirname(lockPath), { recursive: true })
    // Simulates the exact race: this process's own lock (pid below) was
    // stolen for staleness by a second process, which wrote ITS OWN pid —
    // never this process's — before this process's stalled `finally` block
    // finally runs and calls release.
    const anotherOwner = `${process.pid + 1}:their-acquisition`
    writeFileSync(lockPath, `${anotherOwner}\n`)

    releaseDrainLock(lockPath, `${process.pid}:my-acquisition`)

    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf8')).toBe(`${anotherOwner}\n`)
  })

  it('round-3 security review, MEDIUM: releaseDrainLock still deletes a lock this process actually holds', () => {
    const home = tempDir('log-webhook-home-')
    const lockPath = join(home, 'some-task.flush-lock')
    mkdirSync(dirname(lockPath), { recursive: true })
    const token = acquireDrainLock(lockPath)
    expect(token).not.toBeNull()

    releaseDrainLock(lockPath, token as string)

    expect(existsSync(lockPath)).toBe(false)
  })

  it('a second drain in the SAME process that took over a stale lock keeps it — the pid alone never proves ownership', () => {
    const home = tempDir('log-webhook-home-')
    const lockPath = join(home, 'some-task.flush-lock')
    mkdirSync(dirname(lockPath), { recursive: true })
    const first = acquireDrainLock(lockPath) as string
    const staleMtime = new Date(Date.now() - WEBHOOK_DRAIN_LOCK_STALE_MS - 60_000)
    utimesSync(lockPath, staleMtime, staleMtime)
    const second = acquireDrainLock(lockPath)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)

    // The first holder resumes and releases — same pid, different acquisition.
    releaseDrainLock(lockPath, first)

    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf8')).toBe(`${second}\n`)
  })

  it('a stale lock is taken over by exactly one contender, never two', () => {
    const home = tempDir('log-webhook-home-')
    const lockPath = join(home, 'some-task.flush-lock')
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, '999999:crashed-holder\n')
    const staleMtime = new Date(Date.now() - WEBHOOK_DRAIN_LOCK_STALE_MS - 60_000)
    utimesSync(lockPath, staleMtime, staleMtime)

    const winners = [acquireDrainLock(lockPath), acquireDrainLock(lockPath), acquireDrainLock(lockPath)].filter(
      (t) => t !== null
    )

    expect(winners).toHaveLength(1)
    expect(readFileSync(lockPath, 'utf8')).toBe(`${winners[0]}\n`)
    expect(readdirSync(dirname(lockPath)).filter((n) => n.includes('.claimed-'))).toEqual([])
  })

  it('a fresh lock is never taken over — the holder keeps it', () => {
    const home = tempDir('log-webhook-home-')
    const lockPath = join(home, 'some-task.flush-lock')
    mkdirSync(dirname(lockPath), { recursive: true })
    const holder = acquireDrainLock(lockPath) as string
    expect(acquireDrainLock(lockPath)).toBeNull()
    expect(readFileSync(lockPath, 'utf8')).toBe(`${holder}\n`)
  })
})

/** One padded line is deliberately ~2/5 of the cap, so two fit one POST and three never do. */
const CHUNK_FIXTURE_LINE_BYTES = 2 * 1024 * 1024

/** Waits until the fixture server has actually received `count` request(s) — the only signal that proves the drain child has already read the queue file, which a fixed sleep cannot. */
async function waitForRequests(requests: CapturedRequest[], count: number, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (requests.length < count) {
    if (Date.now() > deadline) throw new Error(`fixture server never received ${count} request(s)`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function siblingPath(home: string, issue: number, suffix: string): string {
  return outboxPath(home, issue).replace(/\.ndjson$/, suffix)
}

function seedSibling(home: string, issue: number, suffix: string, lines: string[]): string {
  const p = siblingPath(home, issue, suffix)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${lines.join('\n')}\n`)
  return p
}

describe('drainOutboxToWebhook — a queue larger than one POST catches up in chunks (O1, O4)', () => {
  it('delivers a backlog over the per-POST cap as several chunks, oldest first, and empties the queue', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const path = seedOutbox(home, 710, [
      paddedNdjsonLine('run-1', 710, CHUNK_FIXTURE_LINE_BYTES),
      paddedNdjsonLine('run-2', 710, CHUNK_FIXTURE_LINE_BYTES),
      paddedNdjsonLine('run-3', 710, CHUNK_FIXTURE_LINE_BYTES)
    ])
    expect(readFileSync(path).byteLength).toBeGreaterThan(MAX_WEBHOOK_BODY_BYTES)

    const { result } = await runDrainAsyncCaptured(710, server.url, undefined, cwd, home, undefined, 20000)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 3, bytes: expect.any(Number), chunks: 2, rejected: 0 })
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['run-1', 'run-2'], ['run-3']])
    for (const request of server.requests) {
      expect(Buffer.byteLength(request.body, 'utf8')).toBeLessThanOrEqual(MAX_WEBHOOK_BODY_BYTES)
    }
    expect(queueContent(path)).toBe('')
  }, 30000)

  it('keeps exactly what the server never acknowledged when a chunk fails part-way through a backlog', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startSequencedWebhookServer([200, 500])
    const third = paddedNdjsonLine('run-3', 711, CHUNK_FIXTURE_LINE_BYTES)
    const path = seedOutbox(home, 711, [
      paddedNdjsonLine('run-1', 711, CHUNK_FIXTURE_LINE_BYTES),
      paddedNdjsonLine('run-2', 711, CHUNK_FIXTURE_LINE_BYTES),
      third
    ])

    const { result } = await runDrainAsyncCaptured(711, server.url, undefined, cwd, home, undefined, 20000)
    server.stop()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('log-webhook-drain-failed')
    expect(result.message).toContain('after delivering 1 chunk(s)')
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['run-1', 'run-2'], ['run-3']])
    // The accepted chunk is gone; the refused one is still queued, whole and in
    // order, for the next drain to re-send.
    expect(readFileSync(siblingPath(home, 711, '.draining.ndjson'), 'utf8')).toBe(`${third}\n`)
    expect(queueContent(path)).toBe('')
  }, 30000)

  it('re-sends the same head chunk after a lost acknowledgement, for the server to deduplicate', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startLostAcknowledgementServer(1500)
    const line = ndjsonLine('run-1', 712)
    const path = seedOutbox(home, 712, [line])

    // The server takes the chunk and holds its answer past this client's own
    // bound: delivery happened, the client never learned it did.
    const first = await runDrainAsyncCaptured(712, server.url, undefined, cwd, home, 150)
    expect(first.result.ok).toBe(false)
    if (first.result.ok) throw new Error('unreachable')
    expect(first.result.code).toBe('log-webhook-drain-failed')
    expect(readFileSync(siblingPath(home, 712, '.draining.ndjson'), 'utf8')).toBe(`${line}\n`)

    const second = await runDrainAsyncCaptured(712, server.url, undefined, cwd, home)
    server.stop()

    expect(second.result.ok).toBe(true)
    expect(server.requests.length).toBe(2)
    // Byte-identical bodies: the retry re-sends the same HEAD chunk, which the
    // server collapses by the stable event identity every line carries.
    expect(server.requests[1]?.body).toBe(server.requests[0]?.body)
    expect(queueContent(path)).toBe('')
  }, 30000)

  it('never loses a line appended between two chunks of the same backlog', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startSlowWebhookServer(200, 1200)
    const path = seedOutbox(home, 714, [
      paddedNdjsonLine('run-1', 714, CHUNK_FIXTURE_LINE_BYTES),
      paddedNdjsonLine('run-2', 714, CHUNK_FIXTURE_LINE_BYTES),
      paddedNdjsonLine('run-3', 714, CHUNK_FIXTURE_LINE_BYTES)
    ])
    const appended = ndjsonLine('run-4', 714)

    const drain = runDrainAsyncCaptured(714, server.url, undefined, cwd, home, undefined, 30000)
    // Lands while the FIRST of two chunks is in flight, so the removal that
    // follows it is a removal of a prefix from a file that has both grown at
    // the tail and already been cut at the head — the one place a cut computed
    // in the wrong coordinates silently eats a live event.
    await waitForRequests(server.requests, 1)
    appendFileSync(path, `${appended}\n`)

    const { result } = await drain
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 3, bytes: expect.any(Number), chunks: 2, rejected: 0 })
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['run-1', 'run-2'], ['run-3']])
    expect(readFileSync(path, 'utf8')).toBe(`${appended}\n`)
  }, 45000)

  it('never loses a line another process appends while a chunk is in flight', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startSlowWebhookServer(200, 1200)
    const path = seedOutbox(home, 713, [ndjsonLine('run-1', 713), ndjsonLine('run-2', 713)])
    const appended = ndjsonLine('run-3', 713)

    const drain = runDrainAsyncCaptured(713, server.url, undefined, cwd, home, undefined, 20000)
    // The request arriving proves the drain has already read the queue file, so
    // this append genuinely lands in the window between that read and the
    // rewrite that removes the acknowledged chunk.
    await waitForRequests(server.requests, 1)
    appendFileSync(path, `${appended}\n`)

    const { result } = await drain
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 2, bytes: expect.any(Number), chunks: 1, rejected: 0 })
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['run-1', 'run-2']])
    expect(readFileSync(path, 'utf8')).toBe(`${appended}\n`)
  }, 30000)
})

describe('drainOutboxToWebhook — the rotation backup slot is delivered, not overwritten unread (O2)', () => {
  it('delivers the backup slot before the live file, in order, and removes it once accepted', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const backup = seedSibling(home, 720, '.1.ndjson', [ndjsonLine('old-1', 720), ndjsonLine('old-2', 720)])
    const path = seedOutbox(home, 720, [ndjsonLine('new-1', 720)])

    const { result } = await runDrainAsyncCaptured(720, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 3, bytes: expect.any(Number), chunks: 2, rejected: 0 })
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['old-1', 'old-2'], ['new-1']])
    expect(existsSync(backup)).toBe(false)
    expect(existsSync(siblingPath(home, 720, '.draining.ndjson'))).toBe(false)
    expect(queueContent(path)).toBe('')
  }, 20000)

  it('picks up a backup slot a crashed drain left part-way through, ahead of everything newer', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    seedSibling(home, 721, '.draining.ndjson', [ndjsonLine('oldest-1', 721)])
    seedSibling(home, 721, '.1.ndjson', [ndjsonLine('older-1', 721)])
    const path = seedOutbox(home, 721, [ndjsonLine('new-1', 721)])

    const { result } = await runDrainAsyncCaptured(721, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(true)
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['oldest-1'], ['older-1'], ['new-1']])
    expect(existsSync(siblingPath(home, 721, '.draining.ndjson'))).toBe(false)
    expect(existsSync(siblingPath(home, 721, '.1.ndjson'))).toBe(false)
    expect(queueContent(path)).toBe('')
  }, 20000)

  it('leaves a partly-delivered backup slot for the next drain when the server stops accepting', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(500)
    const backupLine = ndjsonLine('old-1', 722)
    seedSibling(home, 722, '.1.ndjson', [backupLine])
    const liveLine = ndjsonLine('new-1', 722)
    const path = seedOutbox(home, 722, [liveLine])

    const { result } = await runDrainAsyncCaptured(722, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('log-webhook-drain-failed')
    // The live file is never touched while older events are still undelivered:
    // order survives the outage.
    expect(readFileSync(path, 'utf8')).toBe(`${liveLine}\n`)
    expect(readFileSync(siblingPath(home, 722, '.draining.ndjson'), 'utf8')).toBe(`${backupLine}\n`)
  }, 20000)
})

describe('drainOutboxToWebhook — a line the storage contract cannot vouch for blocks nothing (O3)', () => {
  it('sets a corrupt line aside, keeps delivering the lines after it, and warns once per process', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const path = seedOutbox(home, 730, [
      'not valid json',
      ndjsonLine('run-1', 730),
      '{"meta":{"schema":1},"kind":"forge_write"}',
      ndjsonLine('run-2', 730)
    ])

    const { result, stderr } = await runDrainAsyncCaptured(730, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Two chunks, not one: a line being set aside first flushes whatever is
    // already accumulated, so its own bytes can leave the queue immediately
    // after it is filed rather than waiting out a POST.
    expect(result.outcome).toEqual({ flushed: true, lineCount: 2, bytes: expect.any(Number), chunks: 2, rejected: 2 })
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['run-1'], ['run-2']])
    expect(queueContent(path)).toBe('')
    const rejected = rejectedRecords(home, 730)
    expect(rejected.map((r) => r.status)).toEqual(['invalid', 'invalid'])
    expect(rejected.map((r) => r.raw)).toEqual(['not valid json', '{"meta":{"schema":1},"kind":"forge_write"}'])
    expect(rejected[0]?.reason).toBe('not valid JSON')
    // Two rejections, one line on stderr: a broken line must never spam a gate.
    expect(stderr.split('set a queued line aside').length - 1).toBe(1)
  }, 20000)

  it('keeps a line whose schema version this build does not know, and posts everything else', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const unknown = unknownVersionLine('future-1', 731)
    const path = seedOutbox(home, 731, [unknown, ndjsonLine('run-1', 731)])

    const { result } = await runDrainAsyncCaptured(731, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 1, bytes: expect.any(Number), chunks: 1, rejected: 1 })
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['run-1']])
    const rejected = rejectedRecords(home, 731)
    expect(rejected.map((r) => [r.status, r.raw])).toEqual([['unknown_version', unknown]])
    expect(rejected[0]?.reason).toContain('schema version 99')
    expect(queueContent(path)).toBe('')
  }, 20000)

  it('sets aside a single line larger than one POST instead of jamming every future drain on it', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const oversize = paddedNdjsonLine('huge-1', 732, MAX_WEBHOOK_BODY_BYTES + 1024)
    const path = seedOutbox(home, 732, [oversize, ndjsonLine('run-1', 732)])

    const { result } = await runDrainAsyncCaptured(732, server.url, undefined, cwd, home, undefined, 20000)
    server.stop()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.outcome).toEqual({ flushed: true, lineCount: 1, bytes: expect.any(Number), chunks: 1, rejected: 1 })
    expect(server.requests.map((r) => runIdsOf(r.body))).toEqual([['run-1']])
    const rejected = rejectedRecords(home, 732)
    expect(rejected.map((r) => r.status)).toEqual(['too_large'])
    expect(rejected[0]?.reason).toContain(`over the ${MAX_WEBHOOK_BODY_BYTES}-byte per-POST cap`)
    expect(queueContent(path)).toBe('')
  }, 30000)

  it('keeps the bad line queued, and says so, when it cannot be set aside at all', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const path = seedOutbox(home, 733, ['not valid json', ndjsonLine('run-1', 733)])
    // A planted symlink where the rejected file belongs: the hardened append
    // refuses it (`O_NOFOLLOW`), which must never become a silent drop.
    const elsewhere = join(home, 'elsewhere.ndjson')
    writeFileSync(elsewhere, '')
    symlinkSync(elsewhere, siblingPath(home, 733, '.rejected.ndjson'))

    const { result } = await runDrainAsyncCaptured(733, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('log-webhook-drain-rejected-write')
    expect(server.requests.length).toBe(0)
    expect(readFileSync(siblingPath(home, 733, '.draining.ndjson'), 'utf8')).toBe(
      `not valid json\n${ndjsonLine('run-1', 733)}\n`
    )
    expect(queueContent(path)).toBe('')
    expect(readFileSync(elsewhere, 'utf8')).toBe('')
  }, 20000)
})

describe('drainOutboxToWebhook — a rotation landing mid-drain of the live file loses nothing and posts nothing twice (O4)', () => {
  /**
   * Reproduces `log-sink.ts`'s own `appendLine` exactly, for the one case
   * that matters here: it opens the live path with `O_CREAT`, and when that
   * file is ALREADY over `OUTBOX_MAX_BYTES` it renames it to the backup slot
   * and appends into a fresh file at the same path. It takes no drain lock —
   * an append must never wait on a network call — so this can land at any
   * moment, including while a chunk of a multi-chunk drain is in flight.
   */
  function appendThroughRotation(livePath: string, line: string): void {
    let size = 0
    try {
      size = statSync(livePath).size
    } catch {
      size = 0
    }
    if (size > OUTBOX_MAX_BYTES) renameSync(livePath, livePath.replace(/\.ndjson$/, '.1.ndjson'))
    appendFileSync(livePath, `${line}\n`)
  }

  it('delivers every line exactly once when a concurrent append rotates the live file between two chunks', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startSlowWebhookServer(200, 1500)
    // Past the rotation cap on purpose: this is the exact recovery scenario
    // the chunked drain exists for, and at this size ANY concurrent append
    // rotates rather than merely appending.
    const seeded = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'].map((id) =>
      paddedNdjsonLine(id, 740, CHUNK_FIXTURE_LINE_BYTES)
    )
    const path = seedOutbox(home, 740, seeded)
    expect(readFileSync(path).byteLength).toBeGreaterThan(OUTBOX_MAX_BYTES)

    const drain = runDrainAsyncCaptured(740, server.url, undefined, cwd, home, undefined, 40000)
    // The first request arriving proves the drain has read the queue and is
    // mid-POST, which is when a producer's own append is most damaging.
    await waitForRequests(server.requests, 1)
    appendThroughRotation(path, ndjsonLine('run-6', 740))

    const first = await drain
    expect(first.result.ok).toBe(true)
    // A second drain, exactly as the next event's own drain would: whatever
    // the rotation moved aside, and whatever was appended after it, still has
    // to arrive.
    const second = await runDrainAsyncCaptured(740, server.url, undefined, cwd, home, undefined, 40000)
    server.stop()
    expect(second.result.ok).toBe(true)

    const delivered = server.requests.flatMap((r) => runIdsOf(r.body))
    // Exactly once each: a rotation must neither destroy the line appended
    // into the fresh live file nor strand already-delivered bytes in the new
    // backup slot for a later drain to post a second time.
    expect([...delivered].sort()).toEqual(['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6'])
    expect(queueContent(path)).toBe('')
    expect(existsSync(siblingPath(home, 740, '.1.ndjson'))).toBe(false)
    expect(existsSync(siblingPath(home, 740, '.draining.ndjson'))).toBe(false)
  }, 90000)

  it('never overwrites a backlog waiting in the draining file when a later rotation happens', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const refusing = startWebhookServer(500)
    const stranded = ndjsonLine('old-1', 741)
    const path = seedOutbox(home, 741, [stranded])

    // A refused drain leaves the remainder in the private draining file.
    const failed = await runDrainAsyncCaptured(741, refusing.url, undefined, cwd, home)
    refusing.stop()
    expect(failed.result.ok).toBe(false)
    expect(readFileSync(siblingPath(home, 741, '.draining.ndjson'), 'utf8')).toBe(`${stranded}\n`)

    // The producer keeps logging, and its own rotation fills the backup slot
    // while that backlog is still undelivered.
    const rotatedAway = ndjsonLine('mid-1', 741)
    seedSibling(home, 741, '.1.ndjson', [rotatedAway])
    const live = ndjsonLine('new-1', 741)
    writeFileSync(path, `${live}\n`)

    const accepting = startWebhookServer(200)
    const ok = await runDrainAsyncCaptured(741, accepting.url, undefined, cwd, home)
    accepting.stop()

    expect(ok.result.ok).toBe(true)
    // Oldest first, nothing overwritten, nothing skipped.
    expect(accepting.requests.map((r) => runIdsOf(r.body))).toEqual([['old-1'], ['mid-1'], ['new-1']])
    expect(existsSync(siblingPath(home, 741, '.draining.ndjson'))).toBe(false)
    expect(existsSync(siblingPath(home, 741, '.1.ndjson'))).toBe(false)
    expect(queueContent(path)).toBe('')
  }, 30000)
})
