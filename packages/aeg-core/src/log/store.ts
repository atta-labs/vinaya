/**
 * The Vinaya Log's typed storage contract (`task-log-v1` task 2, Issue #562,
 * O1–O3). One interface — `append`, `readPage`, `acknowledge` — that both the
 * real GitHub adapter behind `vinaya log flush`
 * (`apps/cli/src/lib/log-flush.ts`) and the deterministic in-memory fixture
 * backend below implement. This module is the policy layer: pure, no
 * filesystem, no network, no process (`apps/cli/specs/surface.md` "The
 * rule"), so the adversarial fault cases O2/O3 name — a lost acknowledgement,
 * a concurrent append, an overflow, an unknown-version record, redaction on
 * both boundaries — are provable against the fixture backend with no I/O at
 * all.
 *
 * What the contract fixes, in the language of the Boundary (Issue #562):
 * "the outbox rotates into one overwritten backup and flush retries can
 * repeat remotely accepted batches." A record's identity is stable
 * (`recordIdentity`), so re-appending an already-stored batch after a lost
 * acknowledgement is a no-op (`AppendOutcome.duplicates`), not a duplicate;
 * only acknowledged identities are ever removed (`acknowledge`); and an
 * overflow past a store's capacity is REPORTED (`AppendOutcome.overflow`),
 * never the silent single-slot overwrite the outbox rotation performed.
 * Read-back (`readPage` / `classifyStoredLine`) validates each line's schema
 * version and — for a `schema: 2` line — its provenance, re-applies
 * `redact()` at the read (transport) boundary, and PRESERVES a record whose
 * schema version this build has never heard of as an `unknown_version`
 * record for diagnosis rather than dropping it or failing the whole page.
 */

import { redact } from './redact'
import { LogEventSchema, type LogEvent, type Provenance } from './schema'

/**
 * The schema versions this build validates in full. A stored line carrying a
 * `meta.schema` outside this set is neither trusted nor discarded — it is
 * kept as an `unknown_version` read record (O3). Mirrors the
 * `HeaderMetaSchema` discriminated union in `schema.ts` (`1` | `2`); a future
 * task widening that union widens this set in the same change.
 */
export const KNOWN_SCHEMA_VERSIONS = [1, 2] as const

/**
 * A record's stable identity across retry, concurrent append and a lost
 * acknowledgement (O2). A `schema: 2` line carries a per-event `event_id`,
 * generated once per `log()` call — that is the identity. A `schema: 1` line
 * predates `event_id`; its identity is `${run_id}:${seq}`, the same
 * `run_id`/`seq` pair the flush's `<!-- aeg:log:<run_id>:<seq> -->` marker is
 * already keyed on, so the two agree. `null` when neither can be read (a
 * torn or non-conforming line) — a caller treats a null-identity line as one
 * it can never deduplicate or acknowledge, never as identity `""`.
 */
export type RecordIdentity = string

function metaOf(obj: unknown): Record<string, unknown> | null {
  if (obj === null || typeof obj !== 'object') return null
  const meta = (obj as { meta?: unknown }).meta
  if (meta === null || typeof meta !== 'object') return null
  return meta as Record<string, unknown>
}

/**
 * The stable identity of a parsed outbox object, or `null` when it carries
 * neither a usable `event_id` nor a `run_id`/`seq` pair. Pure — takes an
 * already-parsed object so it works on a raw, not-yet-schema-validated line
 * (the read side must identify a line before it knows the line is valid).
 */
export function recordIdentity(obj: unknown): RecordIdentity | null {
  const meta = metaOf(obj)
  if (meta === null) return null
  const eventId = meta.event_id
  if (typeof eventId === 'string' && eventId.length > 0) return eventId
  const runId = meta.run_id
  const seq = meta.seq
  if (typeof runId === 'string' && runId.length > 0 && typeof seq === 'number' && Number.isInteger(seq)) {
    return `${runId}:${seq}`
  }
  return null
}

function schemaVersionOf(obj: unknown): number | null {
  const meta = metaOf(obj)
  const schema = meta?.schema
  return typeof schema === 'number' ? schema : null
}

function isKnownSchema(version: number | null): boolean {
  return version !== null && (KNOWN_SCHEMA_VERSIONS as readonly number[]).includes(version)
}

/** A read-back record — the output of `classifyStoredLine` / `readPage`. */
export type ReadRecord =
  | {
      /** Full `LogEventSchema` validation passed for a known schema version. */
      status: 'ok'
      identity: RecordIdentity
      runId: string
      seq: number
      schema: number
      /** Trust provenance for a `schema: 2` line; `null` for a `schema: 1` line, which has no such field. */
      provenance: Provenance | null
      /** The re-validated event. */
      event: LogEvent
      /** The event re-serialized after re-applying `redact()` — what a transport (the flush) posts, never the raw file bytes. */
      postLine: string
    }
  | {
      /** The line's `meta.schema` is a version this build does not know — kept for diagnosis (O3), never dropped, never posted. */
      status: 'unknown_version'
      identity: RecordIdentity | null
      schema: number | null
      raw: string
      reason: string
    }
  | {
      /** Not JSON, or a KNOWN schema version that failed full validation (including an invalid `provenance`) — a corrupt line. */
      status: 'invalid'
      identity: RecordIdentity | null
      raw: string
      reason: string
    }

/**
 * Classifies one stored line: validates its schema version and (for
 * `schema: 2`) its provenance, re-applies `redact(event, home)` at this read
 * (transport) boundary, and distinguishes three outcomes:
 *
 *  - `ok` — a known schema version that fully re-validated. `postLine` is the
 *    re-redacted, re-serialized form; `provenance` is surfaced from the
 *    header (`null` for `schema: 1`).
 *  - `unknown_version` — the line's `meta.schema` is outside
 *    `KNOWN_SCHEMA_VERSIONS`. Kept verbatim in `raw` for diagnosis (O3): a
 *    real event recorded by a newer producer is never made unreadable, and
 *    never silently dropped, just because this build is older.
 *  - `invalid` — not JSON, no readable schema, or a KNOWN version that failed
 *    `LogEventSchema` (a manual edit, disk corruption, a `redact.ts` gap, or
 *    an out-of-range `provenance`). A corrupt line, distinct from an
 *    unknown-version one.
 */
export function classifyStoredLine(raw: string, home: string): ReadRecord {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { status: 'invalid', identity: null, raw, reason: 'not valid JSON' }
  }

  const version = schemaVersionOf(obj)
  if (version === null) {
    return { status: 'invalid', identity: recordIdentity(obj), raw, reason: 'no readable meta.schema' }
  }
  if (!isKnownSchema(version)) {
    return {
      status: 'unknown_version',
      identity: recordIdentity(obj),
      schema: version,
      raw,
      reason: `schema version ${version} is not one this build validates (${KNOWN_SCHEMA_VERSIONS.join(', ')}) — kept for diagnosis`
    }
  }

  const result = LogEventSchema.safeParse(obj)
  if (!result.success) {
    return {
      status: 'invalid',
      identity: recordIdentity(obj),
      raw,
      reason: result.error.issues[0]?.message ?? 'schema violation'
    }
  }

  const event = result.data
  const identity = recordIdentity(event)
  if (identity === null) {
    // A fully-valid event whose header carries neither event_id nor a
    // run_id/seq pair is structurally impossible under LogEventSchema
    // (headerMetaCore requires both run_id and seq), but the read side never
    // trusts that on faith — an unidentifiable valid line is still refused.
    return { status: 'invalid', identity: null, raw, reason: 'valid event with no derivable identity' }
  }

  const redacted = redact(event, home)
  const provenance = version === 2 ? ((event.meta as { provenance?: Provenance }).provenance ?? null) : null
  return {
    status: 'ok',
    identity,
    runId: event.meta.run_id,
    seq: event.meta.seq,
    schema: version,
    provenance,
    event,
    postLine: JSON.stringify(redacted)
  }
}

/** Diagnostics a page read exposes alongside its records — the "observable loss" O2/O3 require, never a silent skip. */
export type ReadDiagnostics = {
  total: number
  ok: number
  unknownVersion: number
  invalid: number
}

export type ReadPage = {
  records: ReadRecord[]
  /** The cursor to pass for the next page, or `null` when this page reached the end. */
  nextCursor: number | null
  diagnostics: ReadDiagnostics
}

/**
 * Reads one page of `[cursor, cursor + limit)` from `rawLines`, classifying
 * each line through `classifyStoredLine`. Pure over an array a caller has
 * already read (the fixture backend holds it in memory; the GitHub adapter
 * splits the outbox file). `limit` is clamped to at least 1.
 */
export function readPageFrom(
  rawLines: readonly string[],
  cursor: number | null,
  limit: number,
  home: string
): ReadPage {
  const start = cursor === null || cursor < 0 ? 0 : cursor
  const size = Math.max(1, Math.floor(limit))
  const end = Math.min(rawLines.length, start + size)
  const records: ReadRecord[] = []
  const diagnostics: ReadDiagnostics = { total: 0, ok: 0, unknownVersion: 0, invalid: 0 }
  for (let i = start; i < end; i++) {
    const record = classifyStoredLine(rawLines[i] as string, home)
    records.push(record)
    diagnostics.total++
    if (record.status === 'ok') diagnostics.ok++
    else if (record.status === 'unknown_version') diagnostics.unknownVersion++
    else diagnostics.invalid++
  }
  return { records, nextCursor: end < rawLines.length ? end : null, diagnostics }
}

/**
 * An overflow past a store's capacity, reported rather than performed
 * silently (O2). Names exactly which identities were dropped, so a caller can
 * surface the loss — never the single-slot `<name>.1.ndjson` overwrite the
 * outbox rotation did with no record of what it discarded.
 */
export type OverflowDiagnostic = {
  reason: 'capacity'
  dropped: number
  droppedIdentities: RecordIdentity[]
}

/** The outcome of an `append` — every identity that landed, every one skipped as an already-present duplicate, and any overflow the append forced. */
export type AppendOutcome = {
  appended: RecordIdentity[]
  duplicates: RecordIdentity[]
  overflow: OverflowDiagnostic | null
}

/**
 * The storage contract. `append` is idempotent by identity; `readPage`
 * validates and classifies without mutating; `acknowledge` removes ONLY the
 * identities it is handed. A backend implements all four — the fixture below
 * in memory, the GitHub adapter over the outbox file and the forge.
 */
export interface LogStore {
  /** Idempotently append records (raw ndjson strings or event objects). Redacts at this write (sink) boundary. */
  append(records: readonly (string | object)[]): AppendOutcome
  /** Read one page from `cursor` (validation + provenance + unknown-version preservation + transport-boundary redaction). */
  readPage(cursor: number | null, limit: number): ReadPage
  /** Remove exactly the named identities. Returns how many were present and removed. */
  acknowledge(identities: readonly RecordIdentity[]): number
  /** How many records are currently held. */
  size(): number
}

export type FixtureStoreOptions = {
  /**
   * Maximum records held before an append overflows the oldest. Omit for an
   * unbounded store. A capacity of `0` or less is treated as unbounded.
   */
  capacity?: number
  /** Home directory passed to `redact()` for absolute-path rewriting; defaults to `''` (no path rewriting, secret patterns still apply). */
  home?: string
}

type StoredEntry = { identity: RecordIdentity; raw: string }

/**
 * A deterministic, in-memory `LogStore` (O1). No I/O, no clock, no randomness
 * — the same calls in the same order always produce the same state, which is
 * exactly what makes the adversarial O2/O3 cases (lost ack, concurrent
 * append, overflow, unknown version, redaction both sides) unit-testable
 * against it. `append` redacts each record at the write (sink) boundary and
 * skips any whose identity is already stored; `readPage` redacts again at the
 * read (transport) boundary; `acknowledge` removes only the named identities.
 */
export function createFixtureStore(options: FixtureStoreOptions = {}): LogStore {
  const home = options.home ?? ''
  const capacity = options.capacity !== undefined && options.capacity > 0 ? Math.floor(options.capacity) : null
  const entries: StoredEntry[] = []
  const present = new Set<RecordIdentity>()

  function normalize(record: string | object): { identity: RecordIdentity | null; raw: string } {
    if (typeof record === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(record)
      } catch {
        return { identity: null, raw: record }
      }
      // Redact at the sink boundary even for a raw string a caller hands in.
      const redacted = redact(parsed, home)
      return { identity: recordIdentity(redacted), raw: JSON.stringify(redacted) }
    }
    const redacted = redact(record, home)
    return { identity: recordIdentity(redacted), raw: JSON.stringify(redacted) }
  }

  return {
    append(records) {
      const appended: RecordIdentity[] = []
      const duplicates: RecordIdentity[] = []
      const droppedIdentities: RecordIdentity[] = []
      for (const record of records) {
        const { identity, raw } = normalize(record)
        // A line with no derivable identity cannot be deduplicated; store it
        // under a positional identity so it is still readable and
        // acknowledgeable, and count it as appended.
        const id = identity ?? `anon:${entries.length}`
        if (present.has(id)) {
          duplicates.push(id)
          continue
        }
        entries.push({ identity: id, raw })
        present.add(id)
        appended.push(id)
        if (capacity !== null && entries.length > capacity) {
          const evicted = entries.shift() as StoredEntry
          present.delete(evicted.identity)
          droppedIdentities.push(evicted.identity)
        }
      }
      return {
        appended,
        duplicates,
        overflow:
          droppedIdentities.length > 0
            ? { reason: 'capacity', dropped: droppedIdentities.length, droppedIdentities }
            : null
      }
    },
    readPage(cursor, limit) {
      return readPageFrom(
        entries.map((e) => e.raw),
        cursor,
        limit,
        home
      )
    },
    acknowledge(identities) {
      const toRemove = new Set(identities)
      let removed = 0
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as StoredEntry
        if (toRemove.has(entry.identity)) {
          entries.splice(i, 1)
          present.delete(entry.identity)
          removed++
        }
      }
      return removed
    },
    size() {
      return entries.length
    }
  }
}
