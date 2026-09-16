/**
 * `flushOutbox`'s target-selection and per-flush volume bound (task-log-v1
 * 8, Issue #626, O1/O2) — the two pieces `apps/cli/tests/commands/
 * log-flush.test.ts` doesn't cover: `vinaya.config.json`'s `logPublish` key
 * (`resolveLogPublishTarget`/`resolveLogPublishMaxChunksPerFlush`,
 * `../../src/lib/config.js`) and the round-end flush's own refusal to ever
 * default to the task's own Issue (`resolveRoundEndFlushTarget`/
 * `describeSkippedRoundEndFlush`, `../../src/lib/dev-review-loop.js`) are
 * pure — unit-tested directly, no `gh`, no subprocess. The per-flush chunk
 * bound itself is exercised through the real `vinaya log flush` CLI entry
 * point against a stubbed `gh` on `PATH`, the same discipline
 * `commands/log-flush.test.ts` uses and for the same reason: `config.ts`'s
 * `GLOBAL_VINAYA_HOME` is a module-level constant frozen at first import, so
 * a fake `$HOME` only takes effect in a fresh subprocess.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAX_CHUNKS_PER_FLUSH,
  resolveLogPublishMaxChunksPerFlush,
  resolveLogPublishTarget,
  type VinayaConfig
} from '../../src/lib/config.js'
import { describeSkippedRoundEndFlush, resolveRoundEndFlushTarget } from '../../src/lib/dev-review-loop.js'

describe('resolveLogPublishTarget (pure) — O1: target selection honours configuration', () => {
  it('is null when logPublish is absent — the round-end flush publishes nowhere by default', () => {
    expect(resolveLogPublishTarget(null)).toBeNull()
    expect(resolveLogPublishTarget({})).toBeNull()
  })

  it('resolves an explicit issue', () => {
    expect(resolveLogPublishTarget({ logPublish: { issue: 900 } } as VinayaConfig)).toEqual({ issue: 900 })
  })

  it('resolves an explicit pr', () => {
    expect(resolveLogPublishTarget({ logPublish: { pr: 42 } } as VinayaConfig)).toEqual({ pr: 42 })
  })

  it('resolves an explicit webhookUrl, with its headers, ahead of issue/pr', () => {
    expect(
      resolveLogPublishTarget({
        logPublish: { webhookUrl: 'https://example.com/ingest', headers: { 'x-api-key': 'k' } }
      } as VinayaConfig)
    ).toEqual({ webhookUrl: 'https://example.com/ingest', headers: { 'x-api-key': 'k' } })
  })

  it('a logPublish object with neither issue nor pr resolves to null', () => {
    expect(resolveLogPublishTarget({ logPublish: {} } as VinayaConfig)).toBeNull()
  })
})

describe('resolveLogPublishMaxChunksPerFlush (pure) — O2: bounded volume per target', () => {
  it('defaults to DEFAULT_MAX_CHUNKS_PER_FLUSH when unset', () => {
    expect(resolveLogPublishMaxChunksPerFlush(null)).toBe(DEFAULT_MAX_CHUNKS_PER_FLUSH)
    expect(resolveLogPublishMaxChunksPerFlush({ logPublish: { issue: 1 } } as VinayaConfig)).toBe(
      DEFAULT_MAX_CHUNKS_PER_FLUSH
    )
  })

  it('honours a configured positive integer', () => {
    expect(
      resolveLogPublishMaxChunksPerFlush({ logPublish: { issue: 1, maxChunksPerFlush: 12 } } as VinayaConfig)
    ).toBe(12)
  })

  it('falls back to the default for a non-positive or non-integer value rather than disabling the bound', () => {
    expect(resolveLogPublishMaxChunksPerFlush({ logPublish: { issue: 1, maxChunksPerFlush: 0 } } as VinayaConfig)).toBe(
      DEFAULT_MAX_CHUNKS_PER_FLUSH
    )
    expect(
      resolveLogPublishMaxChunksPerFlush({ logPublish: { issue: 1, maxChunksPerFlush: -3 } } as VinayaConfig)
    ).toBe(DEFAULT_MAX_CHUNKS_PER_FLUSH)
  })
})

describe('resolveRoundEndFlushTarget / describeSkippedRoundEndFlush (pure) — O1: never defaults to the task Issue', () => {
  const TASK = 566

  it('is null (no publish) when logPublish is unconfigured — the ordinary default, and not a reported skip', () => {
    expect(resolveRoundEndFlushTarget(null, TASK)).toBeNull()
    expect(describeSkippedRoundEndFlush(null, TASK)).toBeNull()
  })

  it('resolves a configured target distinct from the task Issue', () => {
    const config = { logPublish: { issue: 999 } } as VinayaConfig
    expect(resolveRoundEndFlushTarget(config, TASK)).toEqual({ issue: 999 })
    expect(describeSkippedRoundEndFlush(config, TASK)).toBeNull()
  })

  it('refuses — visibly, never silently — a configured issue equal to the task being flushed, the exact surface fetchFrozenBrief must read', () => {
    const config = { logPublish: { issue: TASK } } as VinayaConfig
    expect(resolveRoundEndFlushTarget(config, TASK)).toBeNull()
    const reason = describeSkippedRoundEndFlush(config, TASK)
    expect(reason).toContain(`#${TASK}`)
    expect(reason).toContain('fetchFrozenBrief')
  })

  it('a configured pr target is never compared against the task Issue number (a distinct forge object)', () => {
    const config = { logPublish: { pr: TASK } } as VinayaConfig
    expect(resolveRoundEndFlushTarget(config, TASK)).toEqual({ pr: TASK })
    expect(describeSkippedRoundEndFlush(config, TASK)).toBeNull()
  })
})

// --- the per-flush chunk bound, end to end -------------------------------

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
      ts: '2026-09-15T00:00:00.000Z',
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

function seedOutbox(home: string, issue: number, chunkCount: number): void {
  // A distinct run_id per line forces a distinct chunk per line (`planFlush`
  // splits at run_id boundaries first) — the cheapest way to manufacture N
  // separate comments without needing N × 65536 chars of payload.
  const lines = Array.from({ length: chunkCount }, (_, i) => ndjsonLine(`run-${i}`, issue))
  const p = outboxPath(home, issue)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${lines.join('\n')}\n`)
}

function stubGh(): { env: Record<string, string>; bodiesLogPath: string } {
  const dir = tempDir('log-flush-lib-gh-')
  const bodiesLogPath = join(dir, 'bodies.log')
  const counterPath = join(dir, 'counter')
  writeFileSync(bodiesLogPath, '')
  writeFileSync(counterPath, '0')
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  echo '{"comments":[]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  n=$3
  bodyFile="$5"
  echo "----CHUNK----" >> "${bodiesLogPath}"
  cat "$bodyFile" >> "${bodiesLogPath}"
  c=$(( $(cat "${counterPath}") + 1 ))
  echo "$c" > "${counterPath}"
  echo "https://github.com/test-owner/test-repo/issues/$n#issuecomment-900$c"
  exit 0
fi
echo "unhandled gh: $*" >&2
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { env: { PATH: `${dir}:${process.env.PATH ?? ''}` }, bodiesLogPath }
}

function chunksOf(bodiesLog: string): string[] {
  return bodiesLog
    .split('----CHUNK----\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

describe('vinaya log flush — per-flush chunk bound (O2, Issue #626)', () => {
  it('posts only DEFAULT_MAX_CHUNKS_PER_FLUSH comments and leaves the rest queued, untouched, for a later flush', () => {
    const cwd = tempDir('log-flush-lib-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-lib-home-')
    const gh = stubGh()

    const totalChunks = DEFAULT_MAX_CHUNKS_PER_FLUSH + 3
    seedOutbox(home, 566, totalChunks)

    const r = runCli(['log', 'flush', '--issue', '566'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    expect(chunksOf(readFileSync(gh.bodiesLogPath, 'utf8')).length).toBe(DEFAULT_MAX_CHUNKS_PER_FLUSH)
    expect(r.stdout).toContain(`${totalChunks - DEFAULT_MAX_CHUNKS_PER_FLUSH} chunk(s) remain queued`)

    // Truncation only of confirmed lines: the un-posted, deferred original
    // lines (`run-5`, `run-6`, `run-7` — this call's own audit trail carries
    // a different, freshly-generated run_id) are still exactly present,
    // never dropped.
    const remaining = readFileSync(outboxPath(home, 566), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const deferredRunIds = remaining.filter((l) => l.meta?.run_id?.startsWith('run-')).map((l) => l.meta.run_id)
    expect(deferredRunIds.length).toBe(totalChunks - DEFAULT_MAX_CHUNKS_PER_FLUSH)
    expect(new Set(deferredRunIds)).toEqual(new Set(['run-5', 'run-6', 'run-7']))

    // Re-running drains the rest — idempotent, never re-posts what already
    // landed. `+ 1`: round 1's own `validated`/`written` audit-trail lines
    // land in the outbox AFTER round 1's plan was already computed, so they
    // form one more chunk round 2 discovers and posts alongside the 3
    // deferred originals — unrelated to this task's bound, pre-existing
    // `flushOutbox` behaviour.
    const r2 = runCli(['log', 'flush', '--issue', '566'], cwd, { HOME: home, ...gh.env })
    expect(r2.status).toBe(0)
    expect(chunksOf(readFileSync(gh.bodiesLogPath, 'utf8')).length).toBe(totalChunks + 1)
    expect(r2.stdout).not.toContain('chunk(s) remain queued')
  }, 20000)

  it('logPublish.maxChunksPerFlush in vinaya.config.json overrides the default bound', () => {
    const cwd = tempDir('log-flush-lib-cwd-')
    initGitRepo(cwd)
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logPublish: { maxChunksPerFlush: 2 } }))
    const home = tempDir('log-flush-lib-home-')
    const gh = stubGh()

    seedOutbox(home, 567, 5)

    const r = runCli(['log', 'flush', '--issue', '567'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    expect(chunksOf(readFileSync(gh.bodiesLogPath, 'utf8')).length).toBe(2)
    expect(r.stdout).toContain('3 chunk(s) remain queued')
  })
})

/**
 * `[task-log-v1] 9` (Issue #631, O2): the driver's own final flush before a
 * pause exit relies on `flushOutbox` (this file) never swallowing a genuine
 * post failure — `apps/cli/specs/log.md` § The flush already documents that
 * a failed chunk logs a `forge_write refused` line, into the very outbox
 * being flushed, before throwing. This pins that contract directly: a `gh`
 * failure must both (a) surface as a non-zero exit, never a quiet success,
 * and (b) leave the `refused` line, and every original unposted line,
 * durably on disk — the record this task's driver-level fix (folding the
 * failure into a pause's own `detail`) depends on existing at all.
 */
function stubFailingGh(): { env: Record<string, string> } {
  const dir = tempDir('log-flush-lib-gh-failing-')
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  echo '{"comments":[]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "gh: could not post comment (simulated failure)" >&2
  exit 1
fi
echo "unhandled gh: $*" >&2
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { env: { PATH: `${dir}:${process.env.PATH ?? ''}` } }
}

describe('vinaya log flush — a gh failure is recorded, never silently swallowed (O2, Issue #631)', () => {
  it('exits non-zero, and the outbox still carries a forge_write refused line plus every original unposted line', () => {
    const cwd = tempDir('log-flush-lib-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-lib-home-')
    const gh = stubFailingGh()

    seedOutbox(home, 568, 1)

    const r = runCli(['log', 'flush', '--issue', '568'], cwd, { HOME: home, ...gh.env })

    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('gh failed posting')

    const survivors = readFileSync(outboxPath(home, 568), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    // The original line this attempt never confirmed posting.
    expect(survivors.some((l) => l.meta?.run_id === 'run-0')).toBe(true)
    // The audit trail of the failure itself — never dropped, never only a
    // stderr line the outbox's own next reader could miss.
    const refused = survivors.find((l) => l.kind === 'forge_write' && l.event === 'refused')
    expect(refused).toBeDefined()
    expect(refused.reason).toContain('failed')
  })
})
