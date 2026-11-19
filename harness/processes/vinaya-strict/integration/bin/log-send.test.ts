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
 * The child replaces fetch with a fake receiver that records each request
 * body in its scratch directory.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnBudgetedAsync, stripVinayaEnv } from '../../../../kernel/conformance/unit/process-fixture'

const OWNER_REPO_DIR = 'test-owner-test-repo'
const COMMAND_PATH = join(import.meta.dir, 'log-send.ts')

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

const legacyUrl = 'https://legacy.example/ingest'

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

async function runSend(cwd: string, home: string) {
  const script = join(cwd, 'run-log-send.ts')
  const requestsFile = join(home, 'legacy-requests')
  writeFileSync(requestsFile, '')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs'
import { logSendCommand } from ${JSON.stringify(COMMAND_PATH)}
globalThis.fetch = async (url, init) => {
  if (String(url) !== ${JSON.stringify(legacyUrl)}) throw new Error('unexpected destination')
  appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(init.body) + '\\n')
  return new Response('ok')
}
await logSendCommand(['--json'])
`
  )
  const { status, stdout, stderr } = await spawnBudgetedAsync(
    ['bun', script],
    { cwd, env: { ...stripVinayaEnv(), HOME: home, CI: '', GITHUB_ACTIONS: '' } },
    20000,
    'log-send'
  )
  let json: SendJson
  try {
    json = (JSON.parse(stdout) as { data: SendJson }).data
  } catch {
    throw new Error(`log send did not print JSON\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
  }
  const requests = readFileSync(requestsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string)
  return { status, json, requests }
}

describe('vinaya log send — delivers a repository’s local events to the configured server (O4, #832)', () => {
  it('moves folder events into the queue, drains a stale draining file too, empties both, and is idempotent', async () => {
    const cwd = tempDir('log-send-cwd-')
    initGitRepo(cwd)
    writeFileSync(join(cwd, 'vinaya.config.json'), '')
    const home = tempDir('log-send-home-')
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { url: legacyUrl } }))

    // Folder events for task 804 (the fallback wrote them there), plus a stale
    // outbox draining file for task 810 a dead drain left behind (O3, via send).
    seed(folderFile(home, 804), [ndjsonLine('folder-1', 804), ndjsonLine('folder-2', 804)])
    seed(outboxSibling(home, 810, '.draining.ndjson'), [ndjsonLine('stranded-1', 810)])

    const first = await runSend(cwd, home)

    expect(first.status).toBe(0)
    expect(first.json.sent).toBe(true)
    expect(first.json.totals?.delivered).toBe(3)
    // Every event reached the server, and nothing is left on local disk.
    const delivered = first.requests.flatMap(runIdsOf).sort()
    expect(delivered).toEqual(['folder-1', 'folder-2', 'stranded-1'])
    expect(existsSync(folderFile(home, 804))).toBe(false)
    expect(existsSync(outboxSibling(home, 810, '.draining.ndjson'))).toBe(false)

    // Idempotent: a second run finds nothing to send and contacts no server.
    const second = await runSend(cwd, home)

    expect(second.status).toBe(0)
    expect(second.json.totals?.delivered).toBe(0)
    expect(second.requests).toHaveLength(0)
  }, 30000)

  it('delivers the named unattributed streams (the CLI’s operation events, a check run’s gate events) as unattributed, beside none.ndjson', async () => {
    const cwd = tempDir('log-send-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-send-home-')
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { url: legacyUrl } }))
    const folder = dirname(folderFile(home, null))
    const stream = join(folder, 'none-cli-operations.ndjson')
    seed(stream, [ndjsonLine('cli-1', null)])
    seed(join(folder, 'none-cli-operations.1.ndjson'), [ndjsonLine('cli-0', null)])
    seed(join(folder, 'none-gates.ndjson'), [ndjsonLine('gate-1', null)])
    seed(folderFile(home, null), [ndjsonLine('shared-1', null)])
    // a name the sink never writes is not delivered
    seed(join(folder, 'none-X.ndjson'), [ndjsonLine('not-a-stream', null)])

    const result = await runSend(cwd, home)

    expect(result.status).toBe(0)
    expect(result.requests.flatMap(runIdsOf).sort()).toEqual(['cli-0', 'cli-1', 'gate-1', 'shared-1'])
    expect(existsSync(join(folder, 'none-gates.ndjson'))).toBe(false)
    expect(result.json.tasks?.every((t) => t.issue === null)).toBe(true)
    expect(existsSync(stream)).toBe(false)
    expect(existsSync(join(folder, 'none-cli-operations.1.ndjson'))).toBe(false)
    expect(existsSync(folderFile(home, null))).toBe(false)
    expect(existsSync(join(folder, 'none-X.ndjson'))).toBe(true)
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
    expect(result.json).toMatchObject({ otlp: { reason: 'no logs.otlp address' } })
    // Nothing was touched — the local file is left exactly where it was.
    expect(existsSync(folderFile(home, 804))).toBe(true)
  }, 20000)
})

it('reports a failed OTLP request after the legacy drain and retries it on the next command', async () => {
  const cwd = tempDir('log-send-cwd-')
  const home = tempDir('log-send-home-')
  initGitRepo(cwd)
  writeFileSync(
    join(cwd, 'vinaya.config.json'),
    JSON.stringify({
      logs: {
        url: 'https://legacy.example/ingest',
        otlp: { url: 'https://collector.example/base?tenant=test', headers: { 'x-test': '${TEST_TOKEN}' } }
      }
    })
  )
  const sdkFolder = join(home, 'sdk-logs')
  writeFileSync(join(cwd, 'log.config.json'), JSON.stringify({ logs: { folder: sdkFolder } }))
  const source = join(sdkFolder, OWNER_REPO_DIR, 'run~writer~000000000000.logs.jsonl')
  seed(source, ['{"resourceLogs":[]}'])
  seed(folderFile(home, 804), [ndjsonLine('legacy', 804)])
  const script = join(cwd, 'run-otlp-send.ts')
  const requests = join(home, 'requests')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs'
import { logSendCommand } from ${JSON.stringify(COMMAND_PATH)}
globalThis.fetch = async (url, init) => {
  appendFileSync(${JSON.stringify(requests)}, String(url) + '\\n')
  if (String(url).startsWith('https://legacy.example')) return new Response('ok')
  if (new Headers(init.headers).get('x-test') !== 'resolved') return new Response(null, { status: 403 })
  return new Response(null, { status: Number(process.env.TEST_STATUS) })
}
await logSendCommand(process.argv.slice(2))
`
  )
  const run = (status: number, args: string[] = []) =>
    spawnBudgetedAsync(
      ['bun', script, ...args],
      {
        cwd,
        env: {
          ...stripVinayaEnv(),
          HOME: home,
          CI: '',
          GITHUB_ACTIONS: '',
          TEST_TOKEN: 'resolved',
          TEST_STATUS: String(status)
        }
      },
      20000,
      'log-send with OpenTelemetry'
    )
  const json = await run(503, ['--json'])
  expect(json.status).toBe(1)
  expect(JSON.parse(json.stdout).data).toMatchObject({
    totals: { delivered: 1 },
    otlp: { sent: 0, failures: [{ reason: 'HTTP 503' }] }
  })
  expect(readFileSync(requests, 'utf8').split('\n').filter(Boolean)).toEqual([
    'https://legacy.example/ingest',
    'https://collector.example/base/v1/logs?tenant=test'
  ])
  const text = await run(503)
  expect(text.status).toBe(1)
  expect(text.stderr).toContain('HTTP 503')
  const retry = await run(204, ['--json'])
  expect(retry.status).toBe(0)
  expect(JSON.parse(retry.stdout).data.otlp).toMatchObject({ sent: 1, failures: [] })
  expect(existsSync(source)).toBe(true)
}, 30000)
