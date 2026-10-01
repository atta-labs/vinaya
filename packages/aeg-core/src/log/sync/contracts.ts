/**
 * The three contracts every Vinaya Log reader codes against
 * (`apps/cli/specs/log-sync.md`):
 *
 *  - a **source** — where pages of stored lines come from (a log folder, a
 *    log server), each page with the cursor to resume from and every gap
 *    the source knows it cannot fill;
 *  - a **cache** — where normalised rows live, with each source's cursor,
 *    the gaps, the quarantined lines and the edits a re-read revealed;
 *  - a **dataset** — what a query reads: the rows, and the gaps and
 *    quarantine it must account for before calling an answer known.
 *
 * These are types only. The sender's own queue contract (`LogStore`,
 * `../store.ts`) is a different thing and stays separate.
 */

import type { Measured } from './measured'
import type { DatasetRow, NormalizedLine, QuarantineRecord, RowOrigin } from './row'

/** A source's opaque resume point. Only the source that issued it interprets it. */
export type SourceCursor = string

/** One stored line as a source hands it over, with its position inside that source. */
export type SourceLine = {
  raw: string
  /** Opaque position within the source — becomes `RowOrigin.position`. */
  position: string
}

/**
 * A stretch of a source's history that can no longer be read — rotated
 * away, expired from a server's retention, rejected on receipt. A gap is
 * reported, never skipped silently. `from`/`to` are opaque source positions
 * bounding it, `null` where the bound is itself unknown.
 */
export type SourceGap = {
  source: string
  from: string | null
  to: string | null
  reason: string
  /** How many lines the gap lost, when the source can count them. */
  lost: Measured<number>
}

/** One page read from a source. `next` is `null` when the source had nothing after this page when read. */
export type SourcePage = {
  lines: readonly SourceLine[]
  next: SourceCursor | null
  gaps: readonly SourceGap[]
}

/** Where stored lines come from. Reading never writes to the source. */
export interface LogSource {
  /** Stable across runs for the same place (for example `folder:<path>`, `server:<url>`) — the key its cursor and gaps are stored under. */
  readonly id: string
  /** Reads the page after `cursor` (`null` = from the beginning), at most `limit` lines. */
  readPage(cursor: SourceCursor | null, limit: number): Promise<SourcePage>
}

/**
 * A stored row later re-read with the same identity and different content.
 * The first row is kept; the difference is recorded here, once per distinct
 * content.
 */
export type RowEdit = {
  identity: string
  /** `contentHash` of the row the cache keeps. */
  keptHash: string
  /** `contentHash` of the differing content that was offered. */
  editedHash: string
  /** Where the differing content was read from. */
  origin: RowOrigin | null
}

/** What storing one normalised line did. */
export type PutOutcome =
  | { type: 'row'; result: 'inserted' | 'duplicate' | 'edited' }
  | { type: 'quarantine'; result: 'inserted' | 'duplicate' }

/** What a query reads. Every list is deterministic, so two backends holding the same content answer identically. */
export interface Dataset {
  /** Every row exactly once, ordered by `time`, then `identity`. */
  rows(): readonly DatasetRow[]
  /** Every recorded gap, in the order recorded. */
  gaps(): readonly SourceGap[]
  /** Every quarantined line, in the order first stored. */
  quarantined(): readonly QuarantineRecord[]
}

/**
 * Where normalised rows live between syncs. Idempotent by identity: storing
 * a row whose identity is already held adds nothing — the same content is a
 * duplicate, different content is recorded as an edit against the kept row.
 * A quarantine record is keyed by its `contentHash`.
 */
export interface LogCache {
  put(line: NormalizedLine): PutOutcome
  /** The cursor last stored for `source`, or `null` when none was. */
  cursor(source: string): SourceCursor | null
  setCursor(source: string, cursor: SourceCursor): void
  /** Records a gap; recording the same gap (same source, bounds and reason) twice keeps one. */
  recordGap(gap: SourceGap): void
  edits(): readonly RowEdit[]
  dataset(): Dataset
}
