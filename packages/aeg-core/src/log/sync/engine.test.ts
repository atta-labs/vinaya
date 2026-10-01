import { describe, expect, it } from 'vitest'
import type { LogSource, SourceGap, SourceLine, SourcePage } from './contracts'
import { syncSource } from './engine'
import { createMemoryCache } from './memory-cache'

/**
 * The sync engine (`apps/cli/specs/log-sync.md`, "The sync run"), driven over a
 * controllable in-memory source and the in-memory cache. The source is pure —
 * no I/O, no clock — and lets a test inject an edit, a deletion, a gap, a
 * read failure or a rewound head, so every path the engine must get right is
 * exercised against a cache whose final state the scenario dictates.
 */

const NOW = new Date('2026-09-25T00:00:00.000Z')

/** A valid schema-3 `operation` line with the given identity, time and result — `result` is the only thing an edit changes. */
function rawLine(eventId: string, ts: string, result = 'ok'): string {
  return JSON.stringify({
    meta: {
      schema: 3,
      ts,
      run_id: 'engine-run',
      seq: 0,
      repo: 'owner/repo',
      vinaya: '0.36.0',
      doctrine: 'aeg-root@engine',
      host: 'cli',
      machine: 'engine-machine',
      event_id: eventId,
      process_id: 'engine-process',
      actor_id: null,
      lineage: { run: null, attempt: null, parent: null },
      input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
      provenance: 'unavailable',
      work: { ref: null, repo: null, change: null, revision: null },
      flow: { id: 'vinaya', version: null },
      runtime: null,
      source: null
    },
    subject: { issue: null, role: 'unattributed' },
    kind: 'operation',
    event: 'completed',
    payload: {},
    operation: 'contract',
    target: null,
    result,
    error_class: null
  })
}

/** Builds a line and its position in a source, position derived from its index. */
function at(index: number, eventId: string, ts: string, result = 'ok'): SourceLine {
  return { raw: rawLine(eventId, ts, result), position: `p${index}` }
}

type SourceScript = {
  /** The lines the source currently holds, in order. Replace this between runs to edit, delete or append. */
  lines: SourceLine[]
  /** Gaps the source reports on its first page of a run. */
  gaps?: SourceGap[]
  /** 1-based page index at which `readPage` throws, once, for this source instance. */
  failOnPage?: number
}

/**
 * A source whose cursor is the opaque string `"<index>"`: `readPage(c, n)`
 * returns the `n` lines at and after that index, with `next` the index after
 * them (or `null` at the end). The engine never parses the cursor; the source
 * is the only reader of it.
 */
function fakeSource(id: string, script: SourceScript): LogSource {
  let call = 0
  return {
    id,
    async readPage(cursor, limit): Promise<SourcePage> {
      call += 1
      if (script.failOnPage === call) throw new Error(`read failed on page ${call}`)
      const start = cursor === null ? 0 : Number(cursor)
      const slice = script.lines.slice(start, start + limit)
      const nextIndex = start + slice.length
      const next = nextIndex < script.lines.length ? String(nextIndex) : null
      const gaps = call === 1 ? (script.gaps ?? []) : []
      return { lines: slice, next, gaps }
    }
  }
}

function identities(cache: ReturnType<typeof createMemoryCache>): string[] {
  return cache
    .dataset()
    .rows()
    .map((r) => r.identity)
}

describe('O1 — a run stores every row once, resumes from the cursor, and dedupes an overlap', () => {
  it('stores each line as a row and reads them all back', async () => {
    const cache = createMemoryCache()
    const source = fakeSource('folder:/a', {
      lines: [at(0, 'e-1', '2026-09-20T10:00:00.000Z'), at(1, 'e-2', '2026-09-20T10:01:00.000Z')]
    })
    const summary = await syncSource(source, cache, { now: NOW })
    expect(summary.rowsStored).toBe(2)
    expect(summary.duplicates).toBe(0)
    expect(summary.completed).toBe(true)
    expect(summary.moreAvailable).toBe(false)
    expect(identities(cache)).toEqual(['e-1', 'e-2'])
  })

  it('a second run over the same source adds no row — one row per identity', async () => {
    const cache = createMemoryCache()
    const lines = [at(0, 'e-1', '2026-09-20T10:00:00.000Z'), at(1, 'e-2', '2026-09-20T10:01:00.000Z')]
    const source = fakeSource('folder:/a', { lines })
    await syncSource(source, cache, { now: NOW })
    const second = await syncSource(fakeSource('folder:/a', { lines }), cache, { now: NOW })
    expect(second.rowsStored).toBe(0)
    expect(second.duplicates).toBe(2)
    expect(identities(cache)).toEqual(['e-1', 'e-2'])
  })

  it('reads from the stored cursor, so new lines appended after a run are picked up', async () => {
    const cache = createMemoryCache()
    const lines = [at(0, 'e-1', '2026-09-20T10:00:00.000Z')]
    await syncSource(fakeSource('folder:/a', { lines }), cache, { now: NOW })
    const grown = [...lines, at(1, 'e-2', '2026-09-20T10:01:00.000Z')]
    const summary = await syncSource(fakeSource('folder:/a', { lines: grown }), cache, { now: NOW })
    expect(summary.rowsStored).toBe(1)
    expect(identities(cache)).toEqual(['e-1', 'e-2'])
  })
})

describe('O2 — a failed run keeps what it stored and the next run ends where a clean run would', () => {
  it('a read failure keeps the pages stored before it and reports the failure', async () => {
    const cache = createMemoryCache()
    const lines = [
      at(0, 'e-1', '2026-09-20T10:00:00.000Z'),
      at(1, 'e-2', '2026-09-20T10:01:00.000Z'),
      at(2, 'e-3', '2026-09-20T10:02:00.000Z')
    ]
    const source = fakeSource('folder:/a', { lines, failOnPage: 3 })
    const summary = await syncSource(source, cache, { now: NOW, pageLimit: 1 })
    expect(summary.failure).toBe('read failed on page 3')
    expect(summary.completed).toBe(false)
    // The two pages read before the failure are stored.
    expect(identities(cache)).toEqual(['e-1', 'e-2'])
    // The cursor was not advanced past the failure.
    expect(cache.cursor('folder:/a')).toBeNull()
  })

  it('resuming after a failure ends in the same cache as one uninterrupted run', async () => {
    const lines = [
      at(0, 'e-1', '2026-09-20T10:00:00.000Z'),
      at(1, 'e-2', '2026-09-20T10:01:00.000Z'),
      at(2, 'e-3', '2026-09-20T10:02:00.000Z'),
      at(3, 'e-4', '2026-09-20T10:03:00.000Z')
    ]

    const clean = createMemoryCache()
    await syncSource(fakeSource('folder:/a', { lines }), clean, { now: NOW, pageLimit: 2 })

    const interrupted = createMemoryCache()
    const failed = await syncSource(fakeSource('folder:/a', { lines, failOnPage: 2 }), interrupted, {
      now: NOW,
      pageLimit: 2
    })
    expect(failed.failure).not.toBeNull()
    const resumed = await syncSource(fakeSource('folder:/a', { lines }), interrupted, { now: NOW, pageLimit: 2 })
    expect(resumed.completed).toBe(true)

    expect(identities(interrupted)).toEqual(identities(clean))
    expect(identities(interrupted)).toEqual(['e-1', 'e-2', 'e-3', 'e-4'])
  })
})

function resultOf(cache: ReturnType<typeof createMemoryCache>, identity: string): unknown {
  const row = cache
    .dataset()
    .rows()
    .find((r) => r.identity === identity)
  return (row?.payload as { result?: unknown } | undefined)?.result
}

describe('O3 — a re-read finds an edit and a deletion without touching the stored row', () => {
  it('a held identity re-read with different content records an edit and keeps the first row', async () => {
    const cache = createMemoryCache()
    const original = [at(0, 'e-1', '2026-09-20T10:00:00.000Z', 'ok'), at(1, 'e-2', '2026-09-20T10:01:00.000Z', 'ok')]
    await syncSource(fakeSource('folder:/a', { lines: original }), cache, { now: NOW })

    const edited = [at(0, 'e-1', '2026-09-20T10:00:00.000Z', 'error'), original[1] as SourceLine]
    const summary = await syncSource(fakeSource('folder:/a', { lines: edited }), cache, { now: NOW })

    expect(summary.edits).toBe(1)
    expect(summary.rowsStored).toBe(0)
    // The first row is kept — the edit is recorded beside it, never over it.
    expect(resultOf(cache, 'e-1')).toBe('ok')
    expect(cache.edits().map((e) => e.identity)).toEqual(['e-1'])
  })

  it('a held identity gone from the re-read window is a deletion, and the row stays', async () => {
    const cache = createMemoryCache()
    const full = [
      at(0, 'e-a', '2026-09-20T10:00:00.000Z'),
      at(1, 'e-b', '2026-09-20T10:01:00.000Z'),
      at(2, 'e-c', '2026-09-20T10:02:00.000Z'),
      at(3, 'e-d', '2026-09-20T10:03:00.000Z'),
      at(4, 'e-e', '2026-09-20T10:04:00.000Z')
    ]
    // A small look-back span, one line per page, so the anchor trails inside the stream.
    const bounds = { now: NOW, pageLimit: 1, lookback: 3 }
    await syncSource(fakeSource('folder:/a', { lines: full }), cache, bounds)
    expect(cache.cursor('folder:/a')).not.toBeNull()

    // e-d is edited out of the folder; the lines after it shift up.
    const without = [full[0], full[1], full[2], full[4]] as SourceLine[]
    const summary = await syncSource(fakeSource('folder:/a', { lines: without }), cache, bounds)

    expect(summary.deletions).toBe(1)
    expect(summary.deleted).toEqual([{ identity: 'e-d', origin: { source: 'folder:/a', position: 'p3' } }])
    // The deleted row is kept — a rebuild could never recover it from the source.
    expect(identities(cache)).toContain('e-d')
  })

  it('a line older than the re-read window is never mistaken for a deletion', async () => {
    const cache = createMemoryCache()
    const full = [
      at(0, 'e-a', '2026-09-20T10:00:00.000Z'),
      at(1, 'e-b', '2026-09-20T10:01:00.000Z'),
      at(2, 'e-c', '2026-09-20T10:02:00.000Z'),
      at(3, 'e-d', '2026-09-20T10:03:00.000Z')
    ]
    const bounds = { now: NOW, pageLimit: 1, lookback: 2 }
    await syncSource(fakeSource('folder:/a', { lines: full }), cache, bounds)
    // The source is unchanged; e-a and e-b are below the trailing window and
    // must not be read as deletions just because this run did not re-read them.
    const summary = await syncSource(fakeSource('folder:/a', { lines: full }), cache, bounds)
    expect(summary.deletions).toBe(0)
  })
})

describe('O4 — a lost span is a gap with its bounds, never a deletion', () => {
  it('a gap the source reports is recorded with its bounds', async () => {
    const cache = createMemoryCache()
    const gap: SourceGap = {
      source: 'server:https://logs',
      from: 'p0',
      to: 'p40',
      reason: 'past retention',
      lost: { known: true, value: 40 }
    }
    const summary = await syncSource(
      fakeSource('server:https://logs', { lines: [at(41, 'e-1', '2026-09-20T10:00:00.000Z')], gaps: [gap] }),
      cache,
      { now: NOW }
    )
    expect(summary.gaps).toBe(1)
    expect(cache.dataset().gaps()).toEqual([gap])
  })

  it('a source whose head is behind the stored cursor is a gap, not a silent reset', async () => {
    const cache = createMemoryCache()
    const lines = [
      at(0, 'e-1', '2026-09-20T10:00:00.000Z'),
      at(1, 'e-2', '2026-09-20T10:01:00.000Z'),
      at(2, 'e-3', '2026-09-20T10:02:00.000Z')
    ]
    const bounds = { now: NOW, pageLimit: 1, lookback: 1 }
    await syncSource(fakeSource('folder:/a', { lines }), cache, bounds)
    expect(cache.cursor('folder:/a')).not.toBeNull()

    // The folder was truncated: nothing remains at or after the stored cursor.
    const summary = await syncSource(fakeSource('folder:/a', { lines: [] }), cache, bounds)
    expect(summary.gaps).toBe(1)
    expect(summary.deletions).toBe(0)
    expect(cache.dataset().gaps()[0]?.reason).toBe('the source head is behind the stored cursor')
  })

  it('a missing identity inside a reported gap is reported as the gap, never as a deletion', async () => {
    const cache = createMemoryCache()
    const full = [
      at(0, 'e-a', '2026-09-20T10:00:00.000Z'),
      at(1, 'e-b', '2026-09-20T10:01:00.000Z'),
      at(2, 'e-c', '2026-09-20T10:02:00.000Z')
    ]
    await syncSource(fakeSource('folder:/a', { lines: full }), cache, { now: NOW })

    const gap: SourceGap = {
      source: 'folder:/a',
      from: 'p1',
      to: 'p1',
      reason: 'rotated away',
      lost: { known: true, value: 1 }
    }
    const summary = await syncSource(
      fakeSource('folder:/a', { lines: [full[0], full[2]] as SourceLine[], gaps: [gap] }),
      cache,
      { now: NOW }
    )
    // e-b is gone, but the source said it lost that span — a gap, not a deletion.
    expect(summary.gaps).toBe(1)
    expect(summary.deletions).toBe(0)
  })
})
