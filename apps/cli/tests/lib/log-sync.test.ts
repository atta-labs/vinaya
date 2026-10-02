import { describe, expect, it } from 'bun:test'
import type { LogCache, LogSource, SourcePage } from '@attalabs/aeg-core'
import { createMemoryCache } from '@attalabs/aeg-core/log'
import { type LogSyncDeps, LOGS_CACHE_DIR_NAME, runLogSync } from '../../src/lib/log-sync.js'
import type { RejectedDiagnostic, ServerLogSource } from '../../src/lib/log-sync-server-source.js'

// `runLogSync` is proved against injected seams, never a real folder or
// server, so every branch below is reproducible on Linux CI with no real
// destination — the same shape `log selftest`'s own tests take.

const SECRET = 'super-secret-read-token-abc123'

/** Stateless and cursor-driven, like a real source: `cursor` names the page index to serve next, so a cache's stored cursor genuinely resumes a later call. */
function fakeFolderSource(pagesOfLines: string[][], id = 'folder:/tmp/test'): LogSource {
  return {
    id,
    async readPage(cursor, _limit): Promise<SourcePage> {
      const index = cursor === null ? 0 : Number(cursor)
      const page = pagesOfLines[index] ?? []
      const isLast = index >= pagesOfLines.length - 1
      return {
        lines: page.map((raw, i) => ({ raw, position: `${index}:${i}` })),
        next: isLast ? null : String(index + 1),
        gaps: []
      }
    }
  }
}

function fakeServerSource(pagesOfLines: string[][], rejected: RejectedDiagnostic): ServerLogSource {
  const base = fakeFolderSource(pagesOfLines, 'server:https://logs.example.com/events')
  return {
    ...base,
    async lookback() {
      return { lines: [], next: null, gaps: [] }
    },
    async retention() {
      return { head: { known: true, value: 0 }, storedCount: { known: true, value: 0 }, gap: { known: true, value: 0 } }
    },
    async rejected() {
      return rejected
    },
    rowsRead() {
      return 0
    }
  }
}

function throwingSource(): LogSource {
  return {
    id: 'folder:/tmp/throws',
    async readPage() {
      throw new Error('ECONNREFUSED: the destination could not be reached')
    }
  }
}

type DepsResult = { deps: LogSyncDeps; out: string[]; err: string[]; deletedCacheCalls: number }

function baseDeps(overrides: Partial<LogSyncDeps> = {}): DepsResult {
  const out: string[] = []
  const err: string[] = []
  let deletedCacheCalls = 0
  const cache: LogCache = createMemoryCache()
  const deps: LogSyncDeps = {
    resolveRepo: async () => ({ owner: 'acme', repo: 'widget' }),
    resolveDestination: async () => ({ kind: 'folder', folder: '/tmp/vinaya-logs-test' }),
    readHeadersRaw: () => undefined,
    resolveHeaders: (headers) => headers,
    cacheDir: async () => '/tmp/vinaya-logs-cache-test',
    deleteCacheFile: () => {
      deletedCacheCalls++
    },
    openCache: () => cache,
    folderSource: () => fakeFolderSource([['not valid json — quarantines']]),
    serverSource: () => fakeServerSource([['also not valid json']], { available: false, reason: 'no rejected route' }),
    env: {},
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t)
  }
  return { deps: { ...deps, ...overrides }, out, err, deletedCacheCalls }
}

describe('runLogSync — resolves the destination and runs the bounded engine (O1)', () => {
  it('reads a folder destination through the folder source and prints the summary', async () => {
    const { deps, out } = baseDeps({
      folderSource: () => fakeFolderSource([['bad-line-1', 'bad-line-2']])
    })
    const code = await runLogSync({ rebuild: false, json: false }, deps)
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).toContain('folder /tmp/vinaya-logs-test')
    expect(text).toContain('Pages read: 1')
    expect(text).toContain('Quarantined: 2')
  })

  it('reads a server destination through the server source and prints its lost-event diagnostic', async () => {
    const { deps, out } = baseDeps({
      resolveDestination: async () => ({ kind: 'server', url: 'https://logs.example.com/v1/repos/acme/widget/events' }),
      readHeadersRaw: () => ({ authorization: `Bearer ${SECRET}` }),
      env: {},
      serverSource: () =>
        fakeServerSource([['bad-event']], {
          available: true,
          window: 100,
          reasons: [{ reason: 'invalid_schema', count: 3 }],
          recent: []
        })
    })
    const code = await runLogSync({ rebuild: false, json: false }, deps)
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).toContain('server https://logs.example.com/v1/repos/acme/widget/events')
    expect(text).toContain('lost events')
    expect(text).toContain('invalid_schema×3')
  })

  it('--json prints the summary as one JSON object', async () => {
    const { deps, out } = baseDeps()
    const code = await runLogSync({ rebuild: false, json: true }, deps)
    expect(code).toBe(0)
    const parsed = JSON.parse(out.join('')) as { schema: number; data: { ok: boolean; summary: { pagesRead: number } } }
    expect(parsed.schema).toBe(1)
    expect(parsed.data.ok).toBe(true)
    expect(parsed.data.summary.pagesRead).toBe(1)
  })
})

describe('runLogSync — exit codes (O2)', () => {
  it('exits 0 when the run completed', async () => {
    const { deps } = baseDeps()
    expect(await runLogSync({ rebuild: false, json: false }, deps)).toBe(0)
  })

  it('exits 1 when the run failed part way, and says so', async () => {
    const { deps, err } = baseDeps({ folderSource: () => throwingSource() })
    const code = await runLogSync({ rebuild: false, json: false }, deps)
    expect(code).toBe(1)
    expect(err.join('')).toContain('stopped early')
    expect(err.join('')).toContain('ECONNREFUSED')
  })

  it('exits 2 when the destination records nothing, and says so', async () => {
    const { deps, err } = baseDeps({
      resolveDestination: async () => ({ kind: 'none', reason: 'no server destination is configured for CI delivery' })
    })
    const code = await runLogSync({ rebuild: false, json: false }, deps)
    expect(code).toBe(2)
    expect(err.join('')).toContain('no server destination is configured')
  })
})

describe('runLogSync — a missing read credential names the variable, never the value (O4)', () => {
  it('no logs.readHeaders configured at all is its own reason, exits 2', async () => {
    const { deps, err } = baseDeps({
      resolveDestination: async () => ({ kind: 'server', url: 'https://logs.example.com/events' }),
      readHeadersRaw: () => undefined
    })
    const code = await runLogSync({ rebuild: false, json: false }, deps)
    expect(code).toBe(2)
    expect(err.join('')).toContain('no read credential is configured')
    expect(err.join('')).toContain('logs.readHeaders')
  })

  it('a configured-but-unset read credential names the variable, never prints the value, exits 2', async () => {
    const { deps, err, out } = baseDeps({
      resolveDestination: async () => ({ kind: 'server', url: 'https://logs.example.com/events' }),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
      readHeadersRaw: () => ({ authorization: 'Bearer ${VINAYA_LOG_READ_TOKEN}' }),
      env: {} // VINAYA_LOG_READ_TOKEN unset
    })
    const code = await runLogSync({ rebuild: false, json: false }, deps)
    expect(code).toBe(2)
    expect(err.join('')).toContain('VINAYA_LOG_READ_TOKEN')
    expect(err.join('')).not.toContain(SECRET)
    expect(out.join('')).not.toContain(SECRET)
  })

  it('never calls the server source at all when the read credential is missing', async () => {
    let called = false
    const { deps } = baseDeps({
      resolveDestination: async () => ({ kind: 'server', url: 'https://logs.example.com/events' }),
      readHeadersRaw: () => undefined,
      serverSource: () => {
        called = true
        return fakeServerSource([[]], { available: false, reason: 'unused' })
      }
    })
    await runLogSync({ rebuild: false, json: false }, deps)
    expect(called).toBe(false)
  })
})

describe('runLogSync — a page-bound stop reports more is available and still exits 0 (O6)', () => {
  it('stops at the page bound, says more is available, and exits 0', async () => {
    const { deps, out } = baseDeps({
      maxPages: 1,
      folderSource: () => fakeFolderSource([['line-a'], ['line-b']])
    })
    const code = await runLogSync({ rebuild: false, json: false }, deps)
    expect(code).toBe(0)
    expect(out.join('')).toContain('More is available')
  })

  it('a second invocation continues from the stored cursor', async () => {
    // `lookback: 1` so the stored cursor anchors just behind the first run's
    // own last page rather than resetting to the start — the engine's cursor
    // trails the furthest point synced by at most the look-back span
    // (`engine.ts`'s `nextAnchor`), so a span of 1 against a 2-line first run
    // is what makes the second run resume past page 0 rather than re-reading
    // the whole source again.
    const cache = createMemoryCache()
    const pages = [['line-a'], ['line-b'], ['line-c']]
    const first = baseDeps({
      maxPages: 2,
      lookback: 1,
      openCache: () => cache,
      folderSource: () => fakeFolderSource(pages)
    })
    const firstCode = await runLogSync({ rebuild: false, json: false }, first.deps)
    expect(firstCode).toBe(0)
    expect(first.out.join('')).toContain('More is available')

    const second = baseDeps({
      maxPages: 2,
      lookback: 1,
      openCache: () => cache,
      folderSource: () => fakeFolderSource(pages)
    })
    const secondCode = await runLogSync({ rebuild: false, json: false }, second.deps)
    expect(secondCode).toBe(0)
    expect(second.out.join('')).not.toContain('More is available')
  })
})

describe('runLogSync — the cache directory and rebuild (O3)', () => {
  it('names the cache directory under the runtime directory as logs-cache', () => {
    expect(LOGS_CACHE_DIR_NAME).toBe('logs-cache')
  })

  it('deletes the cache file only when --rebuild is passed', async () => {
    const seenDeletes: string[] = []
    const { deps } = baseDeps({ deleteCacheFile: (dir) => seenDeletes.push(dir) })
    await runLogSync({ rebuild: false, json: false }, deps)
    expect(seenDeletes).toEqual([])

    const { deps: deps2 } = baseDeps({ deleteCacheFile: (dir) => seenDeletes.push(dir) })
    await runLogSync({ rebuild: true, json: false }, deps2)
    expect(seenDeletes).toEqual(['/tmp/vinaya-logs-cache-test'])
  })

  it('says a rebuilt run cannot recover what the destination no longer retains', async () => {
    const { deps, out } = baseDeps()
    await runLogSync({ rebuild: true, json: false }, deps)
    expect(out.join('')).toContain('cannot be recovered')
  })
})
