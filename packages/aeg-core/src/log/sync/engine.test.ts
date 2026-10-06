import { describe, expect, it } from 'vitest'
import { buildExecutions } from '../fixtures'
import type { LogSource, SourceGap, SourceLine, SourcePage } from './contracts'
import { syncSource } from './engine'
import { createMemoryCache } from './memory-cache'
import { normalizeStoredLine } from './normalize'

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

/** A line naming a schema version no build knows — quarantined as `unknown_version`. */
function unknownVersionLine(index: number, eventId: string): SourceLine {
  return {
    raw: JSON.stringify({ meta: { schema: 99, event_id: eventId, run_id: 'future-run', seq: 0 } }),
    position: `p${index}`
  }
}

/** A line that is not JSON — quarantined as `invalid`. */
function tornLine(index: number): SourceLine {
  return { raw: '{"meta": torn', position: `p${index}` }
}

describe('O5 — a bad line is quarantined and the rest of its page is still stored', () => {
  it('an unknown version and a torn line are quarantined while every valid line is stored', async () => {
    const cache = createMemoryCache()
    const source = fakeSource('folder:/a', {
      lines: [
        at(0, 'e-1', '2026-09-20T10:00:00.000Z'),
        unknownVersionLine(1, 'future-1'),
        tornLine(2),
        at(3, 'e-2', '2026-09-20T10:03:00.000Z')
      ]
    })
    const summary = await syncSource(source, cache, { now: NOW })
    expect(summary.quarantined).toBe(2)
    expect(summary.rowsStored).toBe(2)
    // The two valid lines became rows; neither bad line failed the page.
    expect(identities(cache)).toEqual(['e-1', 'e-2'])
    const quarantined = cache.dataset().quarantined()
    expect(quarantined.map((q) => q.status).sort()).toEqual(['invalid', 'unknown_version'])
  })
})

describe('O6 — a run is bounded and reports when more is available', () => {
  it('stops on its page bound, reports more is available, and advances the cursor', async () => {
    const cache = createMemoryCache()
    const lines = [
      at(0, 'e-1', '2026-09-20T10:00:00.000Z'),
      at(1, 'e-2', '2026-09-20T10:01:00.000Z'),
      at(2, 'e-3', '2026-09-20T10:02:00.000Z'),
      at(3, 'e-4', '2026-09-20T10:03:00.000Z')
    ]
    const bounds = { now: NOW, pageLimit: 1, maxPages: 2, lookback: 1 }
    const first = await syncSource(fakeSource('folder:/a', { lines }), cache, bounds)
    expect(first.pagesRead).toBe(2)
    expect(first.moreAvailable).toBe(true)
    expect(first.completed).toBe(false)
    expect(cache.cursor('folder:/a')).not.toBeNull()

    // Each further run resumes from the bound and makes progress; the source
    // drains in a bounded number of runs and the last one completes.
    let last = first
    for (let run = 0; run < 5 && last.moreAvailable; run++) {
      last = await syncSource(fakeSource('folder:/a', { lines }), cache, bounds)
    }
    expect(last.completed).toBe(true)
    expect(last.moreAvailable).toBe(false)
    expect(identities(cache)).toEqual(['e-1', 'e-2', 'e-3', 'e-4'])
  })

  it('a completed run that reached the source end reports no more available', async () => {
    const cache = createMemoryCache()
    const summary = await syncSource(
      fakeSource('folder:/a', { lines: [at(0, 'e-1', '2026-09-20T10:00:00.000Z')] }),
      cache,
      { now: NOW, maxPages: 50 }
    )
    expect(summary.completed).toBe(true)
    expect(summary.moreAvailable).toBe(false)
  })
})

describe('O7 — a run returns a summary of everything it did', () => {
  it('reports pages, rows, duplicates, edits, deletions, gaps, quarantine and the run flags', async () => {
    const cache = createMemoryCache()
    const gap: SourceGap = {
      source: 'folder:/a',
      from: 'p9',
      to: 'p9',
      reason: 'rotated away',
      lost: { known: true, value: 1 }
    }
    const summary = await syncSource(
      fakeSource('folder:/a', {
        lines: [at(0, 'e-1', '2026-09-20T10:00:00.000Z'), unknownVersionLine(1, 'future-1')],
        gaps: [gap]
      }),
      cache,
      { now: NOW }
    )
    expect(summary).toEqual({
      source: 'folder:/a',
      ranAt: NOW.toISOString(),
      pagesRead: 1,
      rowsStored: 1,
      duplicates: 0,
      edits: 0,
      deletions: 0,
      gaps: 1,
      quarantined: 1,
      completed: true,
      moreAvailable: false,
      failure: null,
      deleted: []
    })
  })
})

/**
 * A server-like source's lines, built from the fixture executions: every
 * valid schema-3 line, positioned by its numeric sequence (`"0"`, `"1"`, …),
 * with its event time rewritten so arrival order is not event-time order —
 * as when several machines send into one stream. Position `i` carries minute
 * `(i * 7) % count` past a fixed instant, a permutation that interleaves the
 * event times of early and late positions.
 */
function outOfOrderLines(count: number): SourceLine[] {
  const valid = buildExecutions()
    .flatMap((execution) => execution.lines)
    .filter((line) => line.validity === 'valid')
    .map((line) => JSON.parse(line.raw) as { meta: { schema: number; ts: string } })
    .filter((event) => event.meta.schema === 3)
  expect(valid.length).toBeGreaterThanOrEqual(count)
  const base = Date.parse('2026-09-20T00:00:00.000Z')
  return valid.slice(0, count).map((event, index) => {
    const ts = new Date(base + ((index * 7) % count) * 60_000).toISOString()
    return { raw: JSON.stringify({ ...event, meta: { ...event.meta, ts } }), position: String(index) }
  })
}

function identityOf(line: SourceLine): string {
  const normalized = normalizeStoredLine(line.raw)
  if (normalized.type !== 'row') throw new Error('expected a row line')
  return normalized.row.identity
}

describe('a deletion is judged by source position, never by event time', () => {
  it('rows arriving out of event-time order give no deletion while the source still holds every row', async () => {
    const all = outOfOrderLines(31)
    const cache = createMemoryCache()
    const bounds = { now: NOW, pageLimit: 5, lookback: 5 }
    await syncSource(fakeSource('server:/x', { lines: all.slice(0, 20) }), cache, bounds)
    // The anchor trails the head: positions before it are not re-read next run.
    expect(cache.cursor('server:/x')).toBe('15')

    const summary = await syncSource(fakeSource('server:/x', { lines: all }), cache, bounds)

    // The new lines' event times interleave with rows before the anchor; none of those is a deletion.
    expect(summary.deletions).toBe(0)
    expect(summary.deleted).toEqual([])
    expect(identities(cache)).toHaveLength(31)
  })

  it('a run whose stored cursor sits at the head re-reads nothing earlier and gives no deletion', async () => {
    const all = outOfOrderLines(31)
    const cache = createMemoryCache()
    await syncSource(fakeSource('server:/x', { lines: all.slice(0, 20) }), cache, { now: NOW })
    cache.setCursor('server:/x', '20')

    const summary = await syncSource(fakeSource('server:/x', { lines: all }), cache, { now: NOW })

    expect(summary.rowsStored).toBe(11)
    expect(summary.deletions).toBe(0)
    expect(identities(cache)).toHaveLength(31)
  })

  it('a stream whose positions restart re-reads no held row on its new lines and gives no deletion', async () => {
    const cache = createMemoryCache()
    const line = (stream: string, index: number, minute: number): SourceLine => ({
      raw: rawLine(`e-${minute}`, `2026-09-20T10:0${minute}:00.000Z`),
      position: `s:${stream}:${index * 100}`
    })
    const live = [0, 1, 2, 3, 4].map((i) => line('live', i, i))
    const bounds = { now: NOW, pageLimit: 1, lookback: 2 }
    await syncSource(fakeSource('folder:/r', { lines: live }), cache, bounds)
    expect(cache.cursor('folder:/r')).toBe('3')

    // The live file rotated: its old lines now sit in the rotated slot, and a
    // fresh live file starts again at byte 0 with new lines.
    const rotated = [0, 1, 2, 3, 4].map((i) => line('rotated', i, i))
    const fresh = [0, 1, 2].map((i) => line('live', i, i + 5))
    const summary = await syncSource(fakeSource('folder:/r', { lines: [...rotated, ...fresh] }), cache, bounds)

    expect(summary.rowsStored).toBe(3)
    expect(summary.deletions).toBe(0)
  })

  it('a row the source removed from inside the re-read span is a deletion with its identity and origin', async () => {
    const all = outOfOrderLines(20)
    const cache = createMemoryCache()
    const bounds = { now: NOW, pageLimit: 5, lookback: 10 }
    await syncSource(fakeSource('server:/x', { lines: all }), cache, bounds)
    expect(cache.cursor('server:/x')).toBe('10')

    const removed = all[13] as SourceLine
    const summary = await syncSource(
      fakeSource('server:/x', { lines: all.filter((line) => line !== removed) }),
      cache,
      bounds
    )

    expect(summary.deletions).toBe(1)
    expect(summary.deleted).toEqual([
      { identity: identityOf(removed), origin: { source: 'server:/x', position: '13' } }
    ])
  })
})
