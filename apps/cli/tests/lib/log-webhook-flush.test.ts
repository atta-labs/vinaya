/**
 * `logPublish.webhookUrl` end to end (`../../src/lib/log-webhook-flush.ts`)
 * — the generic HTTP alternative to `flushOutbox`'s GitHub-comment posting,
 * against a real local HTTP server instead of a stubbed `gh`. Same `HOME`/
 * `cwd` discipline as `log-flush.test.ts`: `HOME` points at a scratch dir so
 * the outbox lives under a throwaway `~/.vinaya/outbox/`, and `cwd` is a
 * real (but unpushed) git repo with an `origin` remote so `resolveRepo()`
 * resolves the same `owner-repo` directory name the sink itself would use.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEBHOOK_FLUSH_LOCK_STALE_MS, releaseFlushLock } from '../../src/lib/log-webhook-flush.js'
import { spawnBudgetedAsync, spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
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

type CliResult = { status: number; stdout: string; stderr: string }

// Issue #660, O3 — this process's own VINAYA_* environment is stripped
// before the fixture's own `env` is applied, so the spawned `vinaya`
// subprocess can only ever resolve its runtime directory from the isolated
// $HOME below; bounded by an explicit budget that throws with the child's
// own captured stdout/stderr on expiry, rather than a bare timeout.
function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  return spawnSyncBudgeted(
    'bun',
    [INDEX, ...args],
    { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...stripVinayaEnv(), ...env } },
    undefined,
    'vinaya log flush'
  )
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

function writeWebhookConfig(cwd: string, webhookUrl: string, headers?: Record<string, string>): void {
  writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logPublish: { webhookUrl, headers } }))
}

/** Like `startWebhookServer`, but holds the response for `delayMs` — long enough for a concurrently-spawned second `vinaya log flush` to observe the first's lock still held. */
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

function runCliAsync(args: string[], cwd: string, env: Record<string, string | undefined>): Promise<CliResult> {
  return spawnBudgetedAsync(
    ['bun', INDEX, ...args],
    { cwd, env: { ...stripVinayaEnv(), ...env } },
    6000,
    'vinaya log flush (async)'
  )
}

describe('vinaya log flush — logPublish.webhookUrl', () => {
  it('POSTs the outbox as ndjson, with configured headers, and truncates on 2xx', () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    writeWebhookConfig(cwd, server.url, { 'x-api-key': 'secret123' })
    const lines = [ndjsonLine('run-1', 700), ndjsonLine('run-2', 700)]
    const path = seedOutbox(home, 700, lines)

    const r = runCli(['log', 'flush', '--issue', '700'], cwd, { HOME: home })
    server.stop()

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('posted 2 line(s)')
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

  it('leaves the outbox untouched and refuses when the webhook does not answer 2xx', () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(500)
    writeWebhookConfig(cwd, server.url)
    const line = ndjsonLine('run-1', 701)
    const path = seedOutbox(home, 701, [line])

    const r = runCli(['log', 'flush', '--issue', '701'], cwd, { HOME: home })
    server.stop()

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-webhook-flush-failed')
    expect(readFileSync(path, 'utf8')).toBe(`${line}\n`)
  })

  it('refuses a corrupt line before posting anything — outbox untouched', () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    writeWebhookConfig(cwd, server.url)
    const path = seedOutbox(home, 702, ['not valid json'])

    const r = runCli(['log', 'flush', '--issue', '702'], cwd, { HOME: home })
    server.stop()

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-webhook-flush-corrupt-line')
    expect(server.requests.length).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('not valid json\n')
  })

  it('round-2 security review, MEDIUM: bounds the POST — a slow/unresponsive endpoint fails fast rather than hanging the flush indefinitely, and the outbox stays untouched', async () => {
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

    // A fresh `bun` subprocess, not an in-process import: `GLOBAL_VINAYA_HOME`
    // (`../../src/lib/config.ts`) is a module-level constant frozen at first
    // import — this file's own top comment documents exactly why every other
    // test here that touches a real outbox goes through a subprocess instead.
    // A short test-only `fetchTimeoutMs` override (this file's own 4th
    // argument to `flushOutboxToWebhook`, never reachable from any real CLI
    // command) means this test never pays the real 30s production bound.
    const script = join(cwd, 'run-flush.ts')
    writeFileSync(
      script,
      `import { flushOutboxToWebhook, WebhookFlushError } from ${JSON.stringify(join(CLI_ROOT, 'src', 'lib', 'log-webhook-flush.ts'))}
      try {
        await flushOutboxToWebhook(704, ${JSON.stringify(`http://127.0.0.1:${server.port}/ingest`)}, undefined, 200)
        console.log(JSON.stringify({ ok: true }))
      } catch (err) {
        console.log(JSON.stringify({ ok: false, isWebhookFlushError: err instanceof WebhookFlushError, message: err instanceof Error ? err.message : String(err) }))
      }`
    )
    const scriptResult = spawnSyncBudgeted(
      'bun',
      [script],
      { encoding: 'utf8', cwd, env: { ...stripVinayaEnv(), HOME: home } },
      undefined,
      'run-flush.ts'
    )
    const r = { stdout: scriptResult.stdout }
    server.stop(true)

    const result = JSON.parse(r.stdout.trim().split('\n').pop() as string)
    expect(result.ok).toBe(false)
    expect(result.isWebhookFlushError).toBe(true)
    expect(result.message).toContain('timed out after 200ms')
    expect(readFileSync(path, 'utf8')).toBe(`${line}\n`)
  }, 10000)

  it('reports nothing to flush for a missing outbox, without contacting the webhook', () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    writeWebhookConfig(cwd, server.url)

    const r = runCli(['log', 'flush', '--issue', '703'], cwd, { HOME: home })
    server.stop()

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('nothing to flush')
    expect(server.requests.length).toBe(0)
  })

  it('round-2 security review, BLOCKER: two concurrent processes never race the same queue file — the loser backs off untouched instead of double-posting or dropping a line', async () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startSlowWebhookServer(200, 500)
    writeWebhookConfig(cwd, server.url)
    const lines = [ndjsonLine('run-1', 705), ndjsonLine('run-2', 705)]
    const path = seedOutbox(home, 705, lines)

    const first = runCliAsync(['log', 'flush', '--issue', '705'], cwd, { HOME: home })
    // Gives the first process time to win the lock and enter its (slow) POST
    // before the second even starts — the second must find the lock already
    // held for the whole window, not race to create it first.
    await new Promise((r) => setTimeout(r, 150))
    const second = runCliAsync(['log', 'flush', '--issue', '705'], cwd, { HOME: home })

    const [r1, r2] = await Promise.all([first, second])
    server.stop()

    const results = [r1, r2]
    const winner = results.find((r) => r.stdout.includes('posted'))
    const loser = results.find((r) => r.stdout.includes('nothing to flush'))

    expect(server.requests.length).toBe(1)
    expect(winner?.stdout).toContain('posted 2 line(s)')
    expect(loser).toBeDefined()
    expect(readFileSync(path, 'utf8')).toBe('')
  }, 10000)

  it('round-2 security review, BLOCKER: a lock abandoned by a crashed holder is stolen once stale, not left to jam every future flush', () => {
    const cwd = tempDir('log-webhook-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-webhook-home-')
    const server = startWebhookServer(200)
    writeWebhookConfig(cwd, server.url)
    const line = ndjsonLine('run-1', 706)
    const path = seedOutbox(home, 706, [line])
    const lockPath = `${path}.flush-lock`
    writeFileSync(lockPath, '999999\n')
    const staleMtime = new Date(Date.now() - WEBHOOK_FLUSH_LOCK_STALE_MS - 5000)
    utimesSync(lockPath, staleMtime, staleMtime)

    const r = runCli(['log', 'flush', '--issue', '706'], cwd, { HOME: home })
    server.stop()

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('posted 1 line(s)')
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('round-3 security review, MEDIUM: releaseFlushLock never deletes a lock another process now owns — a holder stalled past the stale window, then resumed, cannot tear down the lock its own lock was stolen from', () => {
    const home = tempDir('log-webhook-home-')
    const lockPath = join(home, 'some-task.flush-lock')
    mkdirSync(dirname(lockPath), { recursive: true })
    // Simulates the exact race: this process's own lock (pid below) was
    // stolen for staleness by a second process, which wrote ITS OWN pid —
    // never this process's — before this process's stalled `finally` block
    // finally runs and calls release.
    const anotherProcessPid = process.pid + 1
    writeFileSync(lockPath, `${anotherProcessPid}\n`)

    releaseFlushLock(lockPath)

    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf8')).toBe(`${anotherProcessPid}\n`)
  })

  it('round-3 security review, MEDIUM: releaseFlushLock still deletes a lock this process actually holds', () => {
    const home = tempDir('log-webhook-home-')
    const lockPath = join(home, 'some-task.flush-lock')
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, `${process.pid}\n`)

    releaseFlushLock(lockPath)

    expect(existsSync(lockPath)).toBe(false)
  })
})
