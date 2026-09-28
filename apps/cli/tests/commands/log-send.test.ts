/**
 * `vinaya log send` (O4, Issue #832) — delivers a repository's locally-held log
 * events to the configured `logs.url` server, once, driving the SAME
 * `drainOutboxToWebhook` delivery a live event uses.
 *
 * Exercised through a fresh `bun` subprocess, never an in-process import: the
 * command reads its home-relative folder and outbox from `GLOBAL_VINAYA_HOME`
 * (a module-level constant frozen at first import from `homedir()`), so a
 * scratch `$HOME` is the only way its reads and writes land somewhere the test
 * controls — the identical discipline `log-webhook-drain.test.ts` documents.
 * The child's own drain POSTs back to this process's `Bun.serve`, so the launch
 * is async (a synchronous spawn on Bun 1.4.2 would block the one thread that
 * server's handler needs).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture'

const OWNER_REPO_DIR = 'test-owner-test-repo'
const COMMAND_PATH = join(import.meta.dir, '..', '..', 'src', 'commands', 'log-send.ts')

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:test-owner/test-repo.git'], { cwd })
}

/** A valid `schema: 1` line — `classifyStoredLine` vouches for it, and its identity is `${run_id}:${seq}`. */
function ndjsonLine(runId: string, issue: number | null): string {
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
    target: issue === null ? {} : { issue }
  })
}

function runIdsOf(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { meta: { run_id: string } }).meta.run_id)
}

function startWebhookServer(status = 200): { url: string; requests: string[]; stop: () => void } {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(await req.text())
      return new Response(status === 200 ? 'ok' : 'error', { status })
    }
  })
  return { url: `http://127.0.0.1:${server.port}/ingest`, requests, stop: () => server.stop() }
}

function folderFile(home: string, issue: number | null): string {
  return join(home, '.vinaya', 'runtime', OWNER_REPO_DIR, 'logs', OWNER_REPO_DIR, `${issue ?? 'none'}.ndjson`)
}
function outboxSibling(home: string, issue: number | null, suffix: string): string {
  return join(home, '.vinaya', 'outbox', OWNER_REPO_DIR, `${issue ?? 'none'}${suffix}`)
}

function seed(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

type SendJson = {
  sent: boolean
  reason?: string
  totals?: { moved: number; delivered: number; chunks: number; rejected: number }
  tasks?: Array<{ issue: number | null; moved: number; delivered: number }>
}

async function runSend(cwd: string, home: string): Promise<{ status: number; json: SendJson; stdout: string }> {
  const script = join(cwd, 'run-log-send.ts')
  writeFileSync(
    script,
    `import { logSendCommand } from ${JSON.stringify(COMMAND_PATH)}\nawait logSendCommand(['--json'])\n`
  )
  const { status, stdout, stderr } = await spawnBudgetedAsync(
    ['bun', script],
    { cwd, env: { ...stripVinayaEnv(), HOME: home } },
    20000,
    'log-send'
  )
  let json: SendJson
  try {
    json = (JSON.parse(stdout) as { data: SendJson }).data
  } catch {
    throw new Error(`log send did not print JSON\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
  }
  return { status, json, stdout }
}

describe('vinaya log send — delivers a repository’s local events to the configured server (O4, #832)', () => {
  it('moves folder events into the queue, drains a stale draining file too, empties both, and is idempotent', async () => {
    const cwd = tempDir('log-send-cwd-')
    initGitRepo(cwd)
    writeFileSync(join(cwd, 'vinaya.config.json'), '')
    const home = tempDir('log-send-home-')
    const server = startWebhookServer(200)
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { url: server.url } }))

    // Folder events for task 804 (the fallback wrote them there), plus a stale
    // outbox draining file for task 810 a dead drain left behind (O3, via send).
    seed(folderFile(home, 804), [ndjsonLine('folder-1', 804), ndjsonLine('folder-2', 804)])
    seed(outboxSibling(home, 810, '.draining.ndjson'), [ndjsonLine('stranded-1', 810)])

    const first = await runSend(cwd, home)
    server.stop()

    expect(first.status).toBe(0)
    expect(first.json.sent).toBe(true)
    expect(first.json.totals?.delivered).toBe(3)
    // Every event reached the server, and nothing is left on local disk.
    const delivered = server.requests.flatMap(runIdsOf).sort()
    expect(delivered).toEqual(['folder-1', 'folder-2', 'stranded-1'])
    expect(existsSync(folderFile(home, 804))).toBe(false)
    expect(existsSync(outboxSibling(home, 810, '.draining.ndjson'))).toBe(false)

    // Idempotent: a second run finds nothing to send and contacts no server.
    const server2 = startWebhookServer(200)
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { url: server2.url } }))
    const second = await runSend(cwd, home)
    server2.stop()

    expect(second.status).toBe(0)
    expect(second.json.totals?.delivered).toBe(0)
    expect(server2.requests).toHaveLength(0)
  }, 30000)

  it('refuses, exit 1, when the destination is a folder and not a server — there is nothing to send to', async () => {
    const cwd = tempDir('log-send-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-send-home-')
    // A folder destination (or none) has no server to deliver to.
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { folder: join(home, 'elsewhere') } }))
    seed(folderFile(home, 804), [ndjsonLine('folder-1', 804)])

    const result = await runSend(cwd, home)
    expect(result.status).toBe(1)
    expect(result.json.sent).toBe(false)
    expect(result.json.reason).toContain('no server destination')
    // Nothing was touched — the local file is left exactly where it was.
    expect(existsSync(folderFile(home, 804))).toBe(true)
  }, 20000)
})
