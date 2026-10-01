/**
 * `vinaya sync` (`log-readers-v1` 8, O1–O6) — end to end, against a real
 * folder destination under a scratch `$HOME`, never an in-process import:
 * the command reads `GLOBAL_VINAYA_HOME`-relative paths frozen at module
 * load, the same discipline `log-send.test.ts` documents.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../lib/process-fixture'

const OWNER_REPO_DIR = 'test-owner-test-repo'
const COMMAND_PATH = join(import.meta.dir, '..', '..', 'src', 'commands', 'sync.ts')

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
function ndjsonLine(runId: string, seq: number): string {
  return JSON.stringify({
    meta: {
      schema: 1,
      ts: '2026-09-16T00:00:00.000Z',
      run_id: runId,
      seq,
      repo: null,
      vinaya: '0.0.0',
      doctrine: 'unknown',
      host: 'cli',
      machine: 'deadbeef'
    },
    subject: { issue: 804, role: 'developer' },
    kind: 'forge_write',
    event: 'validated',
    payload: {},
    op: 'issue.comment',
    target: { issue: 804 }
  })
}

function folderFile(home: string, issue: number): string {
  return join(home, '.vinaya', 'runtime', OWNER_REPO_DIR, 'logs', OWNER_REPO_DIR, `${issue}.ndjson`)
}

function cacheFile(home: string): string {
  return join(home, '.vinaya', 'runtime', OWNER_REPO_DIR, 'logs-cache', 'cache.sqlite')
}

function seed(path: string, lines: string[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

/**
 * Every regular file under `root`, repo-relative to `root`, with its sha256
 * — a snapshot to diff against later. `.bun` is excluded: the spawned `bun`
 * interpreter writes its own install cache under `$HOME/.bun` as part of
 * running the driver script at all, a fact about the test harness, never
 * about what `vinaya sync` itself writes.
 */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (prefix === '' && entry === '.bun') continue
      const abs = join(dir, entry)
      const rel = prefix === '' ? entry : `${prefix}/${entry}`
      if (statSync(abs).isDirectory()) {
        walk(abs, rel)
        continue
      }
      out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'))
    }
  }
  walk(root, '')
  return out
}

type SyncJson = {
  ok: boolean
  reason?: string
  rebuild?: boolean
  summary?: { pagesRead: number; rowsStored: number; duplicates: number; completed: boolean; moreAvailable: boolean }
}

async function runSync(
  cwd: string,
  home: string,
  args: string[]
): Promise<{ status: number; json: SyncJson; stdout: string }> {
  const script = join(cwd, 'run-sync.ts')
  writeFileSync(
    script,
    `import { syncCommand } from ${JSON.stringify(COMMAND_PATH)}\nprocess.exit(await syncCommand(${JSON.stringify([...args, '--json'])}))\n`
  )
  const { status, stdout, stderr } = spawnSyncBudgeted(
    'bun',
    [script],
    { cwd, encoding: 'utf8', env: { ...stripVinayaEnv(), HOME: home } },
    20_000,
    'vinaya sync'
  )
  let json: SyncJson
  try {
    json = (JSON.parse(stdout) as { data: SyncJson }).data
  } catch {
    throw new Error(`vinaya sync did not print JSON\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
  }
  return { status, json, stdout }
}

describe('vinaya sync — fills, resumes and rebuilds the local cache (O1, O2, O3, O6)', () => {
  it('reads a folder destination, stores its rows, is idempotent, and resumes', async () => {
    const cwd = tempDir('sync-cwd-')
    initGitRepo(cwd)
    const home = tempDir('sync-home-')
    seed(folderFile(home, 804), [ndjsonLine('run-1', 0), ndjsonLine('run-1', 1)])

    const first = await runSync(cwd, home, [])
    expect(first.status).toBe(0)
    expect(first.json.ok).toBe(true)
    expect(first.json.summary?.pagesRead).toBeGreaterThan(0)
    expect(first.json.summary?.rowsStored).toBe(2)
    expect(existsSync(cacheFile(home))).toBe(true)

    // A second run against the SAME, unchanged source finds the same two rows
    // already cached — duplicates, not a second insert.
    const second = await runSync(cwd, home, [])
    expect(second.status).toBe(0)
    expect(second.json.summary?.rowsStored).toBe(0)
    expect(second.json.summary?.duplicates).toBe(2)
  }, 30000)

  it('--rebuild deletes only the cache file, then syncs again from the beginning', async () => {
    const cwd = tempDir('sync-cwd-')
    initGitRepo(cwd)
    const home = tempDir('sync-home-')
    seed(folderFile(home, 804), [ndjsonLine('run-1', 0)])

    const first = await runSync(cwd, home, [])
    expect(first.status).toBe(0)
    expect(existsSync(cacheFile(home))).toBe(true)

    const rebuilt = await runSync(cwd, home, ['--rebuild'])
    expect(rebuilt.status).toBe(0)
    expect(rebuilt.json.rebuild).toBe(true)
    // Rebuilt from scratch: the one row the destination still retains is
    // stored again, not read as a duplicate of a cache that no longer exists.
    expect(rebuilt.json.summary?.rowsStored).toBe(1)
    expect(existsSync(cacheFile(home))).toBe(true)
  }, 30000)

  it('exits 2 and says so when the repository holds no destination', async () => {
    const cwd = tempDir('sync-cwd-')
    initGitRepo(cwd)
    const home = tempDir('sync-home-')
    writeFileSync(
      join(cwd, 'vinaya.config.json'),
      JSON.stringify({
        logs: {
          url: 'https://logs.example.com/events',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
          headers: { authorization: 'Bearer ${MISSING_INGEST_TOKEN}' }
        }
      })
    )
    // CI host (`GITHUB_ACTIONS` set below), a server configured but the
    // ingest credential's own variable unset in this environment — the
    // sink's own CI rule reports `none` rather than falling back to a folder
    // (`log-sink.ts`'s `resolveLogDestinationFrom`).
    const script = join(cwd, 'run-sync.ts')
    writeFileSync(
      script,
      `import { syncCommand } from ${JSON.stringify(COMMAND_PATH)}\nprocess.exit(await syncCommand(['--json']))\n`
    )
    const { status, stdout } = spawnSyncBudgeted(
      'bun',
      [script],
      { cwd, encoding: 'utf8', env: { ...stripVinayaEnv(), HOME: home, GITHUB_ACTIONS: 'true', CI: 'true' } },
      20_000,
      'vinaya sync'
    )
    expect(status).toBe(2)
    const json = (JSON.parse(stdout) as { data: SyncJson }).data
    expect(json.ok).toBe(false)
    expect(json.reason).toContain('no delivery credential')
  }, 30000)
})

describe('vinaya sync — reads the destination and writes only its own cache directory (O5)', () => {
  it('leaves the folder destination byte-for-byte unchanged, and touches nothing under $HOME but logs-cache', async () => {
    const cwd = tempDir('sync-cwd-')
    initGitRepo(cwd)
    const home = tempDir('sync-home-')
    seed(folderFile(home, 804), [ndjsonLine('run-1', 0), ndjsonLine('run-1', 1)])

    const before = snapshot(home)
    const result = await runSync(cwd, home, [])
    expect(result.status).toBe(0)
    const after = snapshot(home)

    // Every file present before the run is still present, byte-identical.
    for (const [rel, hash] of before) {
      expect(after.get(rel), `${rel} should still exist after sync`).toBe(hash)
    }
    // Every NEW file the run introduced lives under this repo's own
    // logs-cache directory — never inside the folder destination itself, and
    // never anywhere else under $HOME.
    const introduced = [...after.keys()].filter((rel) => !before.has(rel))
    expect(introduced.length).toBeGreaterThan(0)
    for (const rel of introduced) {
      expect(rel, `${rel} was written outside logs-cache`).toContain(`${OWNER_REPO_DIR}/logs-cache/`)
    }
  }, 30000)
})
