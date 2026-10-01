/**
 * The sync engine (`apps/cli/specs/log-sync.md`, "The sync run"): the one
 * algorithm that moves a source's stored lines into a cache and is honest
 * about what it could not see. It is pure — a function over a `LogSource` and
 * a `LogCache` handed to it, with the clock and the bounds passed in, no I/O
 * and no clock read of its own.
 *
 * The stored cursor is the **look-back anchor**: it trails the furthest point
 * synced by at most `lookback` lines, so a run reads from it both to resume
 * after a failure (O2) and to re-read the look-back span every run (O3) — the
 * two are the same read. Overlap is deduplicated by identity in the cache
 * (O1), a changed identity is recorded as an edit beside the first row (O3), an
 * identity the cache held in the re-read window that the source no longer
 * returns is a deletion (O3), and a span the source itself reports lost is a
 * gap, never a deletion (O4).
 */

import type { LogCache, LogSource, SourceCursor, SourceGap, SourcePage } from './contracts'
import { unknownBecause } from './measured'
import { normalizeStoredLine } from './normalize'
import type { RowOrigin } from './row'

/** The default look-back span: how many trailing positions a run re-reads to find edits and deletions. */
export const DEFAULT_LOOKBACK = 1000
/** The default page bound: how many pages one run reads before it stops and reports more is available. */
export const DEFAULT_MAX_PAGES = 50
/** The default page size: how many lines a single `readPage` asks for. */
export const DEFAULT_PAGE_LIMIT = 1000

/** The bounds and clock one sync run is given. The engine never reads the clock itself. */
export type SyncOptions = {
  /** The run's wall-clock instant, passed in so the engine stays pure. */
  now: Date
  /** At most this many pages this run (default {@link DEFAULT_MAX_PAGES}). */
  maxPages?: number
  /** At most this many lines per `readPage` (default {@link DEFAULT_PAGE_LIMIT}). */
  pageLimit?: number
  /** The trailing span re-read every run to find edits and deletions (default {@link DEFAULT_LOOKBACK}). */
  lookback?: number
}

/** One identity the cache held in the look-back window that the source no longer returns. The stored row is kept; this is where the loss is reported. */
export type RowDeletion = {
  identity: string
  /** Where the row was last read from, as the cache holds it. */
  origin: RowOrigin | null
}

/** What one sync run did. Every count is of this run alone; the cache holds the running totals. */
export type SyncSummary = {
  /** The source's stable id. */
  source: string
  /** The `now` the run was given, as an ISO instant — the engine's only use of the clock it was handed. */
  ranAt: string
  /** Pages read from the source this run. */
  pagesRead: number
  /** Rows newly inserted this run. */
  rowsStored: number
  /** Rows offered whose identity and content the cache already held. */
  duplicates: number
  /** Distinct edits recorded this run: a held identity re-read with different content. */
  edits: number
  /** Identities found deleted this run — detailed in {@link SyncSummary.deleted}. */
  deletions: number
  /** Gaps recorded this run: a span the source reported it could not fill. */
  gaps: number
  /** Lines quarantined this run: an unknown schema version or a line that failed validation. */
  quarantined: number
  /** `true` when the run reached the end of the source without a failure. */
  completed: boolean
  /** `true` when the run stopped on its page bound with more still to read. */
  moreAvailable: boolean
  /** The failure that ended the run early, or `null` when none. The pages stored before it are kept. */
  failure: string | null
  /** Every deletion this run found. The cache keeps no deletion record, so the run's summary is where a deletion is reported. */
  deleted: readonly RowDeletion[]
}

type Boundary = { cursor: SourceCursor | null; linesBefore: number }

/**
 * Runs one sync of `source` into `cache`.
 *
 * Reads pages from the stored look-back anchor, storing every page's rows and
 * quarantine records before advancing anything (O1), until the source ends, a
 * page bound is hit, or a read fails (O2). The overlap with already-stored
 * data deduplicates by identity and surfaces edits; a held identity gone from
 * the re-read window and not covered by a reported gap is a deletion (O3, O4).
 * The run returns a summary and never reads the clock.
 */
export async function syncSource(source: LogSource, cache: LogCache, options: SyncOptions): Promise<SyncSummary> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT
  const lookback = options.lookback ?? DEFAULT_LOOKBACK
  const id = source.id

  const startCursor = cache.cursor(id)
  const editsBefore = cache.edits().length
  const gapsBefore = cache.dataset().gaps().length

  // What the cache held for this source before the run — its view of the
  // look-back window, used to tell a deletion from an untouched row.
  const priorRows = new Map<string, { time: string; origin: RowOrigin | null }>()
  for (const row of cache.dataset().rows()) {
    if (row.origin?.source === id) priorRows.set(row.identity, { time: row.time, origin: row.origin })
  }

  let pagesRead = 0
  let rowsStored = 0
  let duplicates = 0
  let quarantined = 0
  let failure: string | null = null
  let completed = false
  let sawGap = false

  // Identities the source returned this run, and the time span they cover —
  // the window within which an absent held identity is a deletion.
  const seen = new Set<string>()
  let minSeenTime: string | null = null
  let maxSeenTime: string | null = null

  const boundaries: Boundary[] = []
  let totalLines = 0
  let cursor: SourceCursor | null = startCursor
  let lastNext: SourceCursor | null = null

  while (pagesRead < maxPages) {
    boundaries.push({ cursor, linesBefore: totalLines })
    let page: SourcePage
    try {
      page = await source.readPage(cursor, pageLimit)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      break
    }
    pagesRead++

    // Store every row and quarantine record on the page before advancing the
    // cursor (O1): a failure between the store and the advance would skip
    // lines forever, so the store comes first and the advance is the last act.
    for (const sourceLine of page.lines) {
      const normalized = normalizeStoredLine(sourceLine.raw, { source: id, position: sourceLine.position })
      const outcome = cache.put(normalized)
      if (normalized.type === 'row') {
        seen.add(normalized.row.identity)
        const time = normalized.row.time
        if (minSeenTime === null || time < minSeenTime) minSeenTime = time
        if (maxSeenTime === null || time > maxSeenTime) maxSeenTime = time
      }
      if (outcome.type === 'row') {
        if (outcome.result === 'inserted') rowsStored++
        else if (outcome.result === 'duplicate') duplicates++
        // 'edited' is counted from the cache's own edit log below.
      } else if (outcome.result === 'inserted') {
        quarantined++
      }
      totalLines++
    }

    for (const gap of page.gaps) {
      cache.recordGap(gap)
      sawGap = true
    }

    lastNext = page.next
    cursor = page.next
    if (page.next === null) {
      completed = true
      break
    }
  }

  // A non-null stored cursor that returns nothing is a source whose head has
  // fallen behind what the cache already consumed — a gap, not a silent reset
  // (O4).
  if (failure === null && startCursor !== null && totalLines === 0 && !sawGap && priorRows.size > 0) {
    const headBehind: SourceGap = {
      source: id,
      from: startCursor,
      to: null,
      reason: 'the source head is behind the stored cursor',
      lost: unknownBecause<number>('the source retained nothing from the stored cursor')
    }
    cache.recordGap(headBehind)
    sawGap = true
  }

  const deleted = deriveDeletions({ priorRows, seen, minSeenTime, maxSeenTime, sawGap })

  // Advance the stored cursor to the new look-back anchor only on a clean run:
  // a failure leaves it where it was, so the next run re-reads from the last
  // safe point rather than past the lines it never stored (O2).
  if (failure === null) {
    const anchor = nextAnchor(boundaries, totalLines, lookback)
    if (anchor !== null) cache.setCursor(id, anchor)
  }

  const moreAvailable = failure === null && !completed && lastNext !== null

  return {
    source: id,
    ranAt: options.now.toISOString(),
    pagesRead,
    rowsStored,
    duplicates,
    edits: cache.edits().length - editsBefore,
    deletions: deleted.length,
    gaps: cache.dataset().gaps().length - gapsBefore,
    quarantined,
    completed,
    moreAvailable,
    failure,
    deleted
  }
}

/**
 * The cached identities the source no longer returns inside the time span the
 * run re-read — its deletions. A run that saw any gap derives none: the source
 * reported what it lost, and a reported loss is a gap, never a deletion (O4).
 * Rows older or newer than the re-read span are out of the look-back window
 * and left untouched.
 */
function deriveDeletions(input: {
  priorRows: Map<string, { time: string; origin: RowOrigin | null }>
  seen: Set<string>
  minSeenTime: string | null
  maxSeenTime: string | null
  sawGap: boolean
}): RowDeletion[] {
  const { priorRows, seen, minSeenTime, maxSeenTime, sawGap } = input
  if (sawGap || minSeenTime === null || maxSeenTime === null) return []
  const deleted: RowDeletion[] = []
  for (const [identity, held] of priorRows) {
    if (seen.has(identity)) continue
    if (held.time < minSeenTime || held.time > maxSeenTime) continue
    deleted.push({ identity, origin: held.origin })
  }
  return deleted
}

/**
 * The cursor to store as the next run's look-back anchor: the earliest page
 * boundary that still leaves at most `lookback` lines ahead of it, so the next
 * run re-reads that trailing span and no more (O6). `null` keeps the anchor
 * where it was — at the start of the source — when the whole read fit inside
 * the span.
 */
function nextAnchor(boundaries: Boundary[], totalLines: number, lookback: number): SourceCursor | null {
  const floor = totalLines - lookback
  let chosen: Boundary | null = null
  for (const boundary of boundaries) {
    if (boundary.linesBefore >= floor) {
      chosen = boundary
      break
    }
  }
  return chosen?.cursor ?? null
}
