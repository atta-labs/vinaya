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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEBHOOK_DRAIN_LOCK_STALE_MS, acquireDrainLock, releaseDrainLock } from '../../src/lib/log-webhook-drain.js'
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

type DrainResult =
  | { ok: true; outcome: { flushed: false } | { flushed: true; lineCount: number; bytes: number } }
  | { ok: false; code: string | null; message: string }

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

function runDrain(
  issue: number,
  url: string,
  headers: Record<string, string> | undefined,
  cwd: string,
  home: string
): DrainResult {
  const script = join(cwd, `run-drain-${issue}.ts`)
  writeDrainScript(script, issue, url, headers)
  const r = spawnSyncBudgeted(
    'bun',
    [script],
    { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...stripVinayaEnv(), HOME: home } },
    undefined,
    'drainOutboxToWebhook'
  )
  return parseDrainOutput(r.stdout)
}

// Async launch: the child's own POST can land on THIS process's `Bun.serve()`
// server — a synchronous spawn here would block the one thread that server's
// `fetch` handler also needs to run on, and on Bun 1.4.2 (a genuinely
// blocking synchronous spawn) the request would never be answered at all.
async function runDrainAsync(
  issue: number,
  url: string,
  headers: Record<string, string> | undefined,
  cwd: string,
  home: string
): Promise<DrainResult> {
  const script = join(cwd, `run-drain-${issue}.ts`)
  writeDrainScript(script, issue, url, headers)
  const r = await spawnBudgetedAsync(
    ['bun', script],
    { cwd, env: { ...stripVinayaEnv(), HOME: home } },
    6000,
    'drainOutboxToWebhook (async)'
  )
  return parseDrainOutput(r.stdout)
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
    expect(result.outcome).toEqual({ flushed: true, lineCount: 2, bytes: expect.any(Number) })
    expect(server.requests.length).toBe(1)
    expect(server.requests[0]?.headers['x-api-key']).toBe('secret123')
    expect(server.requests[0]?.headers['content-type']).toBe('application/x-ndjson')
    const posted = server.requests[0]?.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).meta.run_id)
    expect(posted).toEqual(['run-1', 'run-2'])

    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('leaves the outbox untouched and refuses when the webhook does not answer 2xx', async () => {
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
    expect(readFileSync(path, 'utf8')).toBe(`${line}\n`)
  })

  it('refuses a corrupt line before posting anything — outbox untouched', () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    const path = seedOutbox(home, 702, ['not valid json'])

    const result = runDrain(702, server.url, undefined, cwd, home)
    server.stop()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('log-webhook-drain-corrupt-line')
    expect(server.requests.length).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('not valid json\n')
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
    expect(readFileSync(path, 'utf8')).toBe(`${line}\n`)
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
    expect(result.outcome).toEqual({ flushed: false })
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
    expect(winner?.ok && winner.outcome).toEqual({ flushed: true, lineCount: 2, bytes: expect.any(Number) })
    expect(loser).toBeDefined()
    expect(readFileSync(path, 'utf8')).toBe('')
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
    expect(result.outcome).toEqual({ flushed: true, lineCount: 1, bytes: expect.any(Number) })
    expect(readFileSync(path, 'utf8')).toBe('')
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
