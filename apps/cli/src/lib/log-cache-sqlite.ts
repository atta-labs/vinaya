/**
 * The durable `LogCache` (`apps/cli/specs/log-sync.md`): a `node:sqlite`
 * database file inside a directory the caller gives, passing the same
 * shared cache contract (`cache-contract.ts`) the in-memory cache
 * (`createMemoryCache`) does. `node:sqlite` is loaded lazily, inside
 * {@link createSqliteCache} itself, via `createRequire` — never imported at
 * this file's top level — so a command that never opens a cache pays
 * nothing for it.
 *
 * This part adds the schema version and the transaction-per-page guarantee
 * (O2, O3), on top of the storage shape and dataset answers (O1, O4) the
 * previous part landed.
 *
 * **Schema.** `cache.sqlite`'s `PRAGMA user_version` names the schema this
 * file was written under. Opening a file written by a newer version than
 * this build knows refuses outright, naming the file and both versions; an
 * older (including a brand-new, still-`0`) version runs every migration
 * step between it and {@link CURRENT_SCHEMA_VERSION} inside one
 * transaction before anything else touches the file.
 *
 * **Transaction per page.** A write transaction opens lazily on this
 * cache's first `put`/`recordGap` since the last commit, and commits only
 * when `setCursor` is called (or the cache is closed) — so everything a
 * sync run stored since its last cursor advance is durable together with
 * that advance, and a process killed before the next `setCursor` leaves the
 * database at the previous one, a rerun resuming from there and
 * re-processing the lost span (`put`'s own idempotency makes that replay
 * harmless).
 *
 * Lock handling and refusing a bad file or directory land in the next part.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  DatabaseSync as DatabaseSyncType,
  SQLInputValue,
  StatementResultingChanges,
  StatementSync
} from 'node:sqlite'
import type {
  Dataset,
  DatasetRow,
  LogCache,
  Measured,
  NormalizedLine,
  PutOutcome,
  QuarantineRecord,
  RowEdit,
  RowOrigin,
  SourceCursor,
  SourceGap
} from '@attalabs/aeg-core'

/** The database file's own name inside the directory the caller gives (Decisions, `apps/cli/specs/log-sync.md`). */
export const CACHE_FILE_NAME = 'cache.sqlite'

/** This build's schema version — bumped whenever a migration step is added below. */
export const CURRENT_SCHEMA_VERSION = 1

/** One migration step: brings a database from immediately-below `to` up to `to`, inside the caller's own transaction. */
type Migration = { to: number; run(db: DatabaseSyncType): void }

/** Index 0 creates the whole current schema fresh — the step every brand-new (`user_version` still `0`) file runs. A future schema bump adds a step here, from the version before it to the version after, written as an `ALTER`/`CREATE` against what the PRIOR step left behind, never a second full-schema literal. */
const MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    run(db) {
      db.exec(`
  CREATE TABLE IF NOT EXISTS rows (
    identity TEXT PRIMARY KEY,
    schemaVersion INTEGER NOT NULL,
    kind TEXT NOT NULL,
    event TEXT NOT NULL,
    time TEXT NOT NULL,
    runId TEXT NOT NULL,
    seq INTEGER NOT NULL,
    workRef TEXT,
    actor TEXT,
    cliVersion TEXT NOT NULL,
    doctrine TEXT NOT NULL,
    flowId TEXT,
    flowVersion TEXT,
    host TEXT NOT NULL,
    repo TEXT,
    provenance TEXT,
    trust TEXT,
    issue INTEGER,
    pr INTEGER,
    round INTEGER,
    commitSha TEXT,
    role TEXT NOT NULL,
    objectivesVersion TEXT,
    header TEXT NOT NULL,
    payload TEXT NOT NULL,
    contentHash TEXT NOT NULL,
    originSource TEXT,
    originPosition TEXT,
    unknownFields TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rows_kind_event ON rows (kind, event);
  CREATE INDEX IF NOT EXISTS idx_rows_runId ON rows (runId);
  CREATE INDEX IF NOT EXISTS idx_rows_workRef ON rows (workRef);
  CREATE INDEX IF NOT EXISTS idx_rows_time ON rows (time);

  CREATE TABLE IF NOT EXISTS quarantine (
    contentHash TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    identity TEXT,
    schemaVersion INTEGER,
    reason TEXT NOT NULL,
    raw TEXT NOT NULL,
    originSource TEXT,
    originPosition TEXT
  );

  CREATE TABLE IF NOT EXISTS cursors (
    source TEXT PRIMARY KEY,
    cursor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gaps (
    gapKey TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    fromPos TEXT,
    toPos TEXT,
    reason TEXT NOT NULL,
    lost TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS edits (
    editKey TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    keptHash TEXT NOT NULL,
    editedHash TEXT NOT NULL,
    origin TEXT
  );
      `)
    }
  }
]

function gapKeyOf(gap: Pick<SourceGap, 'source' | 'from' | 'to' | 'reason'>): string {
  return JSON.stringify([gap.source, gap.from, gap.to, gap.reason])
}

function editKeyOf(identity: string, editedHash: string): string {
  return JSON.stringify([identity, editedHash])
}

type RowRecord = {
  identity: string
  schemaVersion: number
  kind: string
  event: string
  time: string
  runId: string
  seq: number
  workRef: string | null
  actor: string | null
  cliVersion: string
  doctrine: string
  flowId: string | null
  flowVersion: string | null
  host: string
  repo: string | null
  provenance: string | null
  trust: string | null
  issue: number | null
  pr: number | null
  round: number | null
  commitSha: string | null
  role: string
  objectivesVersion: string | null
  header: string
  payload: string
  contentHash: string
  originSource: string | null
  originPosition: string | null
  unknownFields: string
}

function paramsFromRow(row: DatasetRow): RowRecord {
  return {
    identity: row.identity,
    schemaVersion: row.schema,
    kind: row.kind,
    event: row.event,
    time: row.time,
    runId: row.runId,
    seq: row.seq,
    workRef: row.workRef,
    actor: row.actor,
    cliVersion: row.cliVersion,
    doctrine: row.doctrine,
    flowId: row.flowId,
    flowVersion: row.flowVersion,
    host: row.host,
    repo: row.repo,
    provenance: row.provenance,
    trust: row.trust,
    issue: row.issue,
    pr: row.pr,
    round: row.round,
    commitSha: row.commit,
    role: row.role,
    objectivesVersion: row.objectivesVersion,
    header: JSON.stringify(row.header),
    payload: JSON.stringify(row.payload),
    contentHash: row.contentHash,
    originSource: row.origin?.source ?? null,
    originPosition: row.origin?.position ?? null,
    unknownFields: JSON.stringify(row.unknown)
  }
}

function rowFromRecord(record: RowRecord): DatasetRow {
  return {
    identity: record.identity,
    schema: record.schemaVersion,
    kind: record.kind,
    event: record.event,
    time: record.time,
    runId: record.runId,
    seq: record.seq,
    workRef: record.workRef,
    actor: record.actor,
    cliVersion: record.cliVersion,
    doctrine: record.doctrine,
    flowId: record.flowId,
    flowVersion: record.flowVersion,
    host: record.host,
    repo: record.repo,
    provenance: record.provenance as DatasetRow['provenance'],
    trust: record.trust as DatasetRow['trust'],
    issue: record.issue,
    pr: record.pr,
    round: record.round,
    commit: record.commitSha,
    role: record.role,
    objectivesVersion: record.objectivesVersion,
    header: JSON.parse(record.header) as DatasetRow['header'],
    payload: JSON.parse(record.payload) as DatasetRow['payload'],
    contentHash: record.contentHash,
    origin:
      record.originSource !== null ? { source: record.originSource, position: record.originPosition as string } : null,
    unknown: JSON.parse(record.unknownFields) as DatasetRow['unknown']
  }
}

type QuarantineRecordRow = {
  contentHash: string
  status: string
  identity: string | null
  schemaVersion: number | null
  reason: string
  raw: string
  originSource: string | null
  originPosition: string | null
}

function quarantineFromRecord(record: QuarantineRecordRow): QuarantineRecord {
  return {
    status: record.status as QuarantineRecord['status'],
    identity: record.identity,
    schema: record.schemaVersion,
    reason: record.reason,
    raw: record.raw,
    contentHash: record.contentHash,
    origin:
      record.originSource !== null ? { source: record.originSource, position: record.originPosition as string } : null
  }
}

type GapRow = {
  gapKey: string
  source: string
  fromPos: string | null
  toPos: string | null
  reason: string
  lost: string
}

function gapFromRecord(record: GapRow): SourceGap {
  return {
    source: record.source,
    from: record.fromPos,
    to: record.toPos,
    reason: record.reason,
    lost: JSON.parse(record.lost) as Measured<number>
  }
}

type EditRow = { editKey: string; identity: string; keptHash: string; editedHash: string; origin: string | null }

function editFromRecord(record: EditRow): RowEdit {
  return {
    identity: record.identity,
    keptHash: record.keptHash,
    editedHash: record.editedHash,
    origin: record.origin !== null ? (JSON.parse(record.origin) as RowOrigin) : null
  }
}

/** A durable `LogCache` with the one extra lifecycle method a real file needs: `close()` releases the connection. */
/** Opens (creating if absent) the schema version this build's `user_version` names, or refuses/migrates (O2). Runs before anything else touches the file. */
function openSchema(db: DatabaseSyncType, dbPath: string): void {
  const stored = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (stored > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `cache database was written by a newer schema version (${stored}) than this build knows (${CURRENT_SCHEMA_VERSION}): ${dbPath}`
    )
  }
  if (stored === CURRENT_SCHEMA_VERSION) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const migration of MIGRATIONS) {
      if (migration.to <= stored) continue
      migration.run(db)
    }
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export type SqliteLogCache = LogCache & { close(): void }

/**
 * Opens (or creates) `<dir>/cache.sqlite` as a `LogCache` (O1). `node:sqlite`
 * is required here, lazily, via `createRequire` — this is the only place in
 * the CLI that loads it.
 */
export function createSqliteCache(dir: string): SqliteLogCache {
  const dbPath = join(dir, CACHE_FILE_NAME)

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  const db: DatabaseSyncType = new DatabaseSync(dbPath)
  openSchema(db, dbPath)

  const selectRowHash = db.prepare('SELECT contentHash FROM rows WHERE identity = $identity')
  const insertRow = db.prepare(`
    INSERT INTO rows (
      identity, schemaVersion, kind, event, time, runId, seq, workRef, actor, cliVersion, doctrine,
      flowId, flowVersion, host, repo, provenance, trust, issue, pr, round, commitSha, role,
      objectivesVersion, header, payload, contentHash, originSource, originPosition, unknownFields
    ) VALUES (
      $identity, $schemaVersion, $kind, $event, $time, $runId, $seq, $workRef, $actor, $cliVersion, $doctrine,
      $flowId, $flowVersion, $host, $repo, $provenance, $trust, $issue, $pr, $round, $commitSha, $role,
      $objectivesVersion, $header, $payload, $contentHash, $originSource, $originPosition, $unknownFields
    )
  `)
  const selectAllRows = db.prepare('SELECT * FROM rows ORDER BY time ASC, identity ASC')

  const insertQuarantine = db.prepare(`
    INSERT OR IGNORE INTO quarantine (contentHash, status, identity, schemaVersion, reason, raw, originSource, originPosition)
    VALUES ($contentHash, $status, $identity, $schemaVersion, $reason, $raw, $originSource, $originPosition)
  `)
  const selectAllQuarantine = db.prepare('SELECT * FROM quarantine ORDER BY rowid ASC')

  const selectCursor = db.prepare('SELECT cursor FROM cursors WHERE source = $source')
  const upsertCursor = db.prepare(`
    INSERT INTO cursors (source, cursor) VALUES ($source, $cursor)
    ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor
  `)

  const insertGap = db.prepare(`
    INSERT OR IGNORE INTO gaps (gapKey, source, fromPos, toPos, reason, lost)
    VALUES ($gapKey, $source, $fromPos, $toPos, $reason, $lost)
  `)
  const selectAllGaps = db.prepare('SELECT * FROM gaps ORDER BY rowid ASC')

  const insertEdit = db.prepare(`
    INSERT OR IGNORE INTO edits (editKey, identity, keptHash, editedHash, origin)
    VALUES ($editKey, $identity, $keptHash, $editedHash, $origin)
  `)
  const selectAllEdits = db.prepare('SELECT * FROM edits ORDER BY rowid ASC')

  // The write transaction for the page in progress — begun lazily on this
  // cache's first mutation since the last commit, committed by `setCursor`
  // (or `close`), so a page's rows, quarantine records and new cursor land
  // together (O3).
  let pageOpen = false

  function beginPage(): void {
    if (pageOpen) return
    db.exec('BEGIN IMMEDIATE')
    pageOpen = true
  }

  function commitPage(): void {
    if (!pageOpen) return
    db.exec('COMMIT')
    pageOpen = false
  }

  function run(stmt: StatementSync, params: Record<string, SQLInputValue>): StatementResultingChanges {
    return stmt.run(params)
  }

  const dataset: Dataset = {
    rows() {
      return (selectAllRows.all() as RowRecord[]).map(rowFromRecord)
    },
    gaps() {
      return (selectAllGaps.all() as GapRow[]).map(gapFromRecord)
    },
    quarantined() {
      return (selectAllQuarantine.all() as QuarantineRecordRow[]).map(quarantineFromRecord)
    }
  }

  return {
    put(line: NormalizedLine): PutOutcome {
      beginPage()
      if (line.type === 'quarantine') {
        const record = line.record
        const outcome = run(insertQuarantine, {
          contentHash: record.contentHash,
          status: record.status,
          identity: record.identity,
          schemaVersion: record.schema,
          reason: record.reason,
          raw: record.raw,
          originSource: record.origin?.source ?? null,
          originPosition: record.origin?.position ?? null
        })
        return { type: 'quarantine', result: outcome.changes > 0 ? 'inserted' : 'duplicate' }
      }
      const incoming = line.row
      const existing = selectRowHash.get({ identity: incoming.identity }) as { contentHash: string } | undefined
      if (existing === undefined) {
        run(insertRow, paramsFromRow(incoming))
        return { type: 'row', result: 'inserted' }
      }
      if (existing.contentHash === incoming.contentHash) return { type: 'row', result: 'duplicate' }
      run(insertEdit, {
        editKey: editKeyOf(incoming.identity, incoming.contentHash),
        identity: incoming.identity,
        keptHash: existing.contentHash,
        editedHash: incoming.contentHash,
        origin: incoming.origin ? JSON.stringify(incoming.origin) : null
      })
      return { type: 'row', result: 'edited' }
    },
    cursor(source: string): SourceCursor | null {
      const record = selectCursor.get({ source }) as { cursor: string } | undefined
      return record?.cursor ?? null
    },
    setCursor(source: string, cursor: SourceCursor): void {
      beginPage()
      run(upsertCursor, { source, cursor })
      commitPage()
    },
    recordGap(gap: SourceGap): void {
      beginPage()
      run(insertGap, {
        gapKey: gapKeyOf(gap),
        source: gap.source,
        fromPos: gap.from,
        toPos: gap.to,
        reason: gap.reason,
        lost: JSON.stringify(gap.lost)
      })
    },
    edits(): readonly RowEdit[] {
      return (selectAllEdits.all() as EditRow[]).map(editFromRecord)
    },
    dataset(): Dataset {
      return dataset
    },
    close(): void {
      commitPage()
      db.close()
    }
  }
}
