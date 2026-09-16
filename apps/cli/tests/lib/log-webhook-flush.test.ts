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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
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
})
