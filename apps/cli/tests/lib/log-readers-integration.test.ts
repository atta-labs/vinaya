import { beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildExecutions,
  catchesAndEscapes,
  checkOutcomes,
  createMemoryCache,
  FIXTURE_REPO,
  NO_LABELS_REASON,
  normalizeStoredLine,
  QUESTIONS,
  recurringFindings,
  type Dataset,
  type QuestionId
} from '@attalabs/aeg-core/log'
import { resolveLogsHeaderValues } from '../../src/lib/config.js'
import { CACHE_FILE_NAME, createSqliteCache } from '../../src/lib/log-cache-sqlite.js'
import { appendHardenedLine, outboxPathFor } from '../../src/lib/log-sink.js'
import { createFolderLogSource } from '../../src/lib/log-sync-folder-source.js'
import { type LogSyncDeps, runLogSync } from '../../src/lib/log-sync.js'
import { createServerLogSource, type ServerSourceFetch } from '../../src/lib/log-sync-server-source.js'

// The one place the parts the rest of this tranche proved separately — the
// folder source, the server source, the durable SQLite cache and the ten
// questions plus the confidence comparison — meet with nothing faked except
// the network (`apps/cli/specs/log-sync.md`). A real folder is written with
// the sink's own hardened append, a fake `fetch` implements the log server's
// own wire contract (`apps/log-server/specs/server.md` § 5) so the real
// server source runs unchanged, and `runLogSync` is the same library
// function `vinaya sync` calls. A defect this test finds inside one of
// those parts is an escalation naming that part, never a fix here
// (Issue #931, "Traps to avoid").

const [FIXTURE_OWNER, FIXTURE_REPO_NAME] = FIXTURE_REPO.split('/')
const REPO = { owner: FIXTURE_OWNER as string, repo: FIXTURE_REPO_NAME as string }
const SERVER_EVENTS_URL = `https://logs.example.com/v1/repos/${FIXTURE_REPO}/events`
const SERVER_READ_TOKEN = 'fixture-log-read-token-abc123'
const SERVER_ENV = { FIXTURE_LOG_READ_TOKEN: SERVER_READ_TOKEN }
const RUN_NOW = new Date('2026-09-10T00:00:00.000Z')

function allRawLines(): string[] {
  return buildExecutions().flatMap((execution) => execution.lines.map((line) => line.raw))
}

/** The in-memory dataset every prior query task's own test is proven against (`convergence.test.ts`'s `datasetOf`). */
function fixtureDataset(lines: readonly string[]): Dataset {
  const cache = createMemoryCache()
  for (const [position, raw] of lines.entries()) {
    cache.put(normalizeStoredLine(raw, { source: 'fixtures', position: String(position) }))
  }
  return cache.dataset()
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `vinaya-log-readers-${prefix}-`))
}

/**
 * Writes `lines` to a real log folder via the sink's own hardened append
 * (`appendHardenedLine`), one file per stream, at the exact path the sink's
 * own `outboxPathFor` names — the same layout `apps/cli/specs/log-sync.md`
 * ("The folder source") describes. Each line's own `subject.issue` (set on
 * every fixture line, including the schema 1/2 ones built by hand) decides
 * which stream it lands in, exactly as a real process's `log()` would.
 */
function writeLinesToFolder(folderRoot: string, lines: readonly string[]): void {
  for (const raw of lines) {
    const parsed = JSON.parse(raw) as { subject?: { issue?: number | null } }
    const issue = parsed.subject?.issue ?? null
    const path = outboxPathFor({ outboxRoot: () => folderRoot }, REPO, issue)
    const failure = appendHardenedLine(path, `${raw}\n`)
    if (failure) throw new Error(`fixture folder write failed: ${failure}`)
  }
}

type StoredEvent = { seq: number; event: unknown }

/** A fake `fetch` implementing just enough of the log server's wire contract (events/stats/rejected, token-gated) to prove the server source with no network — the same shape `log-sync-server-source.test.ts` uses. */
function fakeServer(lines: readonly string[], token: string): ServerSourceFetch {
  const events: StoredEvent[] = lines.map((raw, i) => ({ seq: i + 1, event: JSON.parse(raw) }))
  return async (input, init) => {
    const url = new URL(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers.authorization !== `Bearer ${token}`) return new Response(null, { status: 401 })
    if (url.pathname.endsWith('/stats')) {
      const lastSeq = events.length > 0 ? (events[events.length - 1] as StoredEvent).seq : 0
      return Response.json({
        repo: FIXTURE_REPO,
        events: events.length,
        rejected: 0,
        bytes: 0,
        oldest_ts: null,
        newest_ts: null,
        last_seq: lastSeq
      })
    }
    if (url.pathname.endsWith('/rejected')) {
      return Response.json({ repo: FIXTURE_REPO, window: 0, reasons: [], recent: [] })
    }
    const after = Number(url.searchParams.get('after') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '1000')
    const page = events.filter((e) => e.seq > after).slice(0, limit)
    const body =
      page.length > 0
        ? `${page.map((e) => JSON.stringify({ seq: e.seq, status: 'ok', event: e.event })).join('\n')}\n`
        : ''
    const next = page.length > 0 ? String((page[page.length - 1] as StoredEvent).seq) : String(after)
    return new Response(body, { status: 200, headers: { 'vinaya-log-next-after': next } })
  }
}

function deleteCacheFile(dir: string): void {
  const file = join(dir, CACHE_FILE_NAME)
  if (existsSync(file)) unlinkSync(file)
}

/** A `LogSyncDeps` reading a real folder — `folderRootRef.current` so a test can swap what the destination retains between two runs (O3). */
function folderDeps(folderRootRef: { current: string }, cacheDir: string): LogSyncDeps {
  return {
    resolveRepo: async () => REPO,
    resolveDestination: async () => ({ kind: 'folder', folder: folderRootRef.current }),
    readHeadersRaw: () => undefined,
    resolveHeaders: (headers) => headers,
    cacheDir: async () => cacheDir,
    deleteCacheFile,
    openCache: (dir) => createSqliteCache(dir),
    folderSource: (folder, repo) => createFolderLogSource({ folderRoot: folder, repo }),
    serverSource: (): never => {
      throw new Error('not used by the folder destination')
    },
    env: {},
    now: () => RUN_NOW,
    stdout: () => {},
    stderr: () => {}
  }
}

/** A `LogSyncDeps` reading a fake server over the real server source — `linesRef.current` so a test can swap what the server retains between two runs (O3). */
function serverDeps(linesRef: { current: readonly string[] }, cacheDir: string): LogSyncDeps {
  return {
    resolveRepo: async () => REPO,
    resolveDestination: async () => ({ kind: 'server', url: SERVER_EVENTS_URL }),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
    readHeadersRaw: () => ({ authorization: 'Bearer ${FIXTURE_LOG_READ_TOKEN}' }),
    resolveHeaders: (headers) => resolveLogsHeaderValues(headers, SERVER_ENV),
    cacheDir: async () => cacheDir,
    deleteCacheFile,
    openCache: (dir) => createSqliteCache(dir),
    folderSource: (): never => {
      throw new Error('not used by the server destination')
    },
    serverSource: (url, headers, env) =>
      createServerLogSource({
        fetchImpl: fakeServer(linesRef.current, SERVER_READ_TOKEN),
        eventsUrl: url,
        readHeaders: headers,
        env
      }),
    env: SERVER_ENV,
    now: () => RUN_NOW,
    stdout: () => {},
    stderr: () => {}
  }
}

/** Reads the cache's dataset into plain arrays before closing it — `dataset()`'s own methods query live prepared statements, which `close()` would otherwise finalize out from under a caller that reads after reopening elsewhere. */
function readCacheDataset(cacheDir: string): Dataset {
  const cache = createSqliteCache(cacheDir)
  const rows = cache.dataset().rows()
  const gaps = cache.dataset().gaps()
  const quarantined = cache.dataset().quarantined()
  cache.close()
  return { rows: () => rows, gaps: () => gaps, quarantined: () => quarantined }
}

async function syncFolderCache(
  lines: readonly string[]
): Promise<{ folderRoot: string; cacheDir: string; dataset: Dataset }> {
  const folderRoot = tmpDir('folder')
  const cacheDir = tmpDir('folder-cache')
  writeLinesToFolder(folderRoot, lines)
  const code = await runLogSync({ rebuild: false, json: false }, folderDeps({ current: folderRoot }, cacheDir))
  expect(code).toBe(0)
  return { folderRoot, cacheDir, dataset: readCacheDataset(cacheDir) }
}

async function syncServerCache(lines: readonly string[]): Promise<{ cacheDir: string; dataset: Dataset }> {
  const cacheDir = tmpDir('server-cache')
  const code = await runLogSync({ rebuild: false, json: false }, serverDeps({ current: lines }, cacheDir))
  expect(code).toBe(0)
  return { cacheDir, dataset: readCacheDataset(cacheDir) }
}

function rowsWithoutOrigin(dataset: Dataset): unknown[] {
  return dataset.rows().map(({ origin: _origin, ...rest }) => rest)
}

function quarantinedWithoutOrigin(dataset: Dataset): unknown[] {
  return dataset.quarantined().map(({ origin: _origin, ...rest }) => rest)
}

/** Every registered question's (and the confidence comparison's) answer over one dataset, keyed the same way `QUESTIONS` is. */
function allAnswers(dataset: Dataset): Record<QuestionId, unknown> {
  const out = {} as Record<QuestionId, unknown>
  for (const id of Object.keys(QUESTIONS) as QuestionId[]) {
    out[id] = QUESTIONS[id].run(dataset)
  }
  return out
}

/** The one `findings_compared` line the fixtures ever name a recurring finding on (`three-rounds-recurring-finding`, unit 102, round 2 — `convergence.test.ts`'s own documented fact). Found structurally, never by a hand-copied line number. */
function findRecurringFindingsLineIndex(lines: readonly string[]): number {
  const index = lines.findIndex((raw) => {
    const parsed = JSON.parse(raw) as { kind?: string; event?: string; recurring?: unknown }
    return (
      parsed.kind === 'dev_review_loop' &&
      parsed.event === 'findings_compared' &&
      Array.isArray(parsed.recurring) &&
      parsed.recurring.includes('fnd-auth-1')
    )
  })
  if (index === -1) throw new Error('fixtures no longer name fnd-auth-1 as a recurring finding — update this test')
  return index
}

describe('log-readers integration — fixtures, a folder cache, a server cache and a rebuild (log-readers-v1 12)', () => {
  let fixtures: Dataset
  let folder: { folderRoot: string; cacheDir: string; dataset: Dataset }
  let server: { cacheDir: string; dataset: Dataset }

  beforeAll(async () => {
    const lines = allRawLines()
    fixtures = fixtureDataset(lines)
    folder = await syncFolderCache(lines)
    server = await syncServerCache(lines)
  })

  describe('O1 — the folder-synced and server-synced caches end holding the same rows', () => {
    it('both real caches hold the same rows, quarantine the same lines, and record no gap', () => {
      expect(rowsWithoutOrigin(folder.dataset)).toEqual(rowsWithoutOrigin(server.dataset))
      expect(quarantinedWithoutOrigin(folder.dataset)).toEqual(quarantinedWithoutOrigin(server.dataset))
      expect(folder.dataset.gaps()).toEqual([])
      expect(server.dataset.gaps()).toEqual([])
      // Sanity: the real caches actually hold rows and quarantine records,
      // not an accidentally-empty dataset passing by vacuous equality.
      expect(folder.dataset.rows().length).toBeGreaterThan(0)
      expect(folder.dataset.quarantined().length).toBeGreaterThan(0)
    })
  })

  describe('O2 — every question and the confidence comparison answer identically from all three datasets', () => {
    it('the fixtures, the folder-synced cache and the server-synced cache agree on every registered answer', () => {
      const fixtureAnswers = allAnswers(fixtures)
      expect(allAnswers(folder.dataset)).toEqual(fixtureAnswers)
      expect(allAnswers(server.dataset)).toEqual(fixtureAnswers)
    })
  })

  describe('O3 — deleting the cache file and syncing again', () => {
    it('rebuilding from the same, unmodified folder returns identical answers', async () => {
      const before = allAnswers(readCacheDataset(folder.cacheDir))
      const deps = folderDeps({ current: folder.folderRoot }, folder.cacheDir)
      const code = await runLogSync({ rebuild: true, json: false }, deps)
      expect(code).toBe(0)
      const after = allAnswers(readCacheDataset(folder.cacheDir))
      expect(after).toEqual(before)
    })

    it('a source line removed before the rebuild is absent from the rebuilt answers', async () => {
      const fullLines = allRawLines()
      const removedIndex = findRecurringFindingsLineIndex(fullLines)
      const reducedLines = fullLines.filter((_, i) => i !== removedIndex)

      const fullFolder = tmpDir('rebuild-full')
      const reducedFolder = tmpDir('rebuild-reduced')
      writeLinesToFolder(fullFolder, fullLines)
      writeLinesToFolder(reducedFolder, reducedLines)
      const cacheDir = tmpDir('rebuild-cache')
      const folderRootRef = { current: fullFolder }
      const deps = folderDeps(folderRootRef, cacheDir)

      expect(await runLogSync({ rebuild: false, json: false }, deps)).toBe(0)
      const before = readCacheDataset(cacheDir)
      expect(recurringFindings(before).findings).toContainEqual(
        expect.objectContaining({ unit: '102', round: 2, id: 'fnd-auth-1' })
      )
      const rowsBefore = before.rows().length

      // The destination no longer retains the removed line by the time the
      // rebuild runs — the cache file is deleted and the next sync starts
      // from the beginning of what the (now smaller) folder still holds, the
      // same "cannot be recovered by a rebuild" case `--rebuild` documents
      // (`apps/cli/specs/log-sync.md`, "`--rebuild`").
      folderRootRef.current = reducedFolder
      expect(await runLogSync({ rebuild: true, json: false }, deps)).toBe(0)
      const after = readCacheDataset(cacheDir)

      // "Reported as no longer retained": the dataset's own coverage is
      // exactly one row short — never silently the same count — and the
      // specific finding that line alone carried is gone from the answer.
      expect(after.rows().length).toBe(rowsBefore - 1)
      expect(recurringFindings(after).findings).not.toContainEqual(expect.objectContaining({ id: 'fnd-auth-1' }))
    })
  })

  describe('O4 — a missing human label, incident link or usage observation reads unknown, never a number', () => {
    it('reads unknown identically in the in-memory dataset and in a real synced cache', () => {
      for (const dataset of [fixtures, folder.dataset]) {
        const catches = catchesAndEscapes(dataset)
        expect(catches.escapes).toEqual({ known: false, reason: NO_LABELS_REASON })

        const checks = checkOutcomes(dataset)
        expect(checks.falseRejections).toEqual({ known: false, reason: NO_LABELS_REASON })

        const usage = QUESTIONS.q3.run(dataset) as {
          coverage: { unknowns: readonly { figure: string; reason: string }[] }
        }
        expect(usage.coverage.unknowns.length).toBeGreaterThan(0)
        for (const unknown of usage.coverage.unknowns) expect(typeof unknown.reason).toBe('string')
      }
    })
  })
})

describe('log-readers integration — the question registry (O5)', () => {
  it('holds exactly the ten questions and the confidence comparison, each a registered query over the dataset', () => {
    // Written once, by hand, from `apps/cli/specs/log-sync.md` ("The
    // questions") — never derived from `QUESTIONS` itself, or a dropped or
    // silently-added entry could never fail this.
    const expectedIds: QuestionId[] = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'confidence']
    expect((Object.keys(QUESTIONS) as QuestionId[]).slice().sort()).toEqual(expectedIds.slice().sort())

    const dataset = fixtureDataset(allRawLines())
    for (const id of expectedIds) {
      const entry = QUESTIONS[id]
      expect(typeof entry.run).toBe('function')
      expect(() => entry.run(dataset)).not.toThrow()
    }
  })
})
