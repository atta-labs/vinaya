/**
 * `RepoLog` — one SQLite-backed Durable Object per repository: the store, the
 * reader and the stats reporter for that repository's log
 * (`apps/log-server/specs/server.md` §§ 3–5).
 *
 * One object owns one repository, so every write to it is serialized: arrival
 * order is well defined and a reader's position is simply the row number. The
 * Worker has already checked the token before anything reaches here; this
 * class re-parses the path anyway (`route.ts`) rather than trusting that it
 * was the only caller.
 *
 * Identity and classification are never reimplemented here. `recordIdentity`
 * and `classifyStoredLine` come from `@attalabs/aeg-core/log` — the same
 * functions the sender's own storage contract uses, so the two sides can
 * never disagree about what counts as the same event, or about which lines
 * are valid.
 */

import { DurableObject } from 'cloudflare:workers'
import { classifyStoredLine, recordIdentity } from '@attalabs/aeg-core/log'
import { parseRoute, repoName, type Route } from './route'

export interface Env {
  REPO_LOG: DurableObjectNamespace<RepoLog>
  /** Write-only bearer token, accepted on the ingest route alone. A Worker secret, never in the repository. */
  INGEST_TOKEN: string
  /** Read-only bearer token, accepted on the read and stats routes alone. A Worker secret, never in the repository. */
  READ_TOKEN: string
}

/** A line over this size is rejected rather than stored (spec § 3). */
export const MAX_LINE_BYTES = 1024 * 1024

/** A body over this size is `413` (spec § 5); the sender never posts more than 5 MiB. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** How much of a rejected line is kept for diagnosis (spec § 4). */
const REJECTED_LINE_BYTES = 64 * 1024

/** The read route's default and maximum page size (spec § 5). */
export const READ_LIMIT_MAX = 1000

/**
 * `classifyStoredLine(raw, home)` rewrites absolute paths under `home` to
 * `~/…`. The server is not the machine that produced the event and has no
 * such directory, so it passes the empty string: every other redaction the
 * function applies (tokens, `Authorization: Bearer …`) still runs, and no
 * path rewriting happens here at all — the sender already redacted against
 * its own home before it posted.
 */
const NO_HOME = ''

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function byteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function truncateToBytes(value: string, max: number): string {
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= max) return value
  return decoder.decode(bytes.slice(0, max))
}

/** `meta.ts` of an already-parseable line, for the stats route's time range. `null` when it carries none. */
function timestampOf(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    const meta = (parsed as { meta?: unknown } | null)?.meta
    if (meta === null || typeof meta !== 'object') return null
    const ts = (meta as { ts?: unknown }).ts
    return typeof ts === 'string' ? ts : null
  } catch {
    return null
  }
}

function jsonError(status: 400 | 404 | 405 | 413, error: string): Response {
  return Response.json({ error }, { status })
}

/** A query parameter that must be a non-negative integer when present. */
function parseNonNegativeInteger(raw: string | null, fallback: number): number | 'invalid' {
  if (raw === null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) return 'invalid'
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : 'invalid'
}

export class RepoLog extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    // `seq` is a plain INTEGER PRIMARY KEY — the rowid alias — and never
    // AUTOINCREMENT: rows are never deleted here, so rowids are already
    // monotonic, and AUTOINCREMENT would cost one more row write per insert
    // against the free plan's daily allowance (spec § 2). The UNIQUE index on
    // `event_id` is the ONLY index: each additional one is another row
    // written per event.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq         INTEGER PRIMARY KEY,
        event_id    TEXT NOT NULL UNIQUE,
        status      TEXT NOT NULL,
        ts          TEXT,
        received_at INTEGER NOT NULL,
        line        TEXT NOT NULL
      )`
    )
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS rejected (
        id          INTEGER PRIMARY KEY,
        received_at INTEGER NOT NULL,
        reason      TEXT NOT NULL,
        line        TEXT
      )`
    )
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parsed = parseRoute(url, request.method)
    if (!parsed.ok) return jsonError(parsed.status, `no such route (${parsed.status})`)

    switch (parsed.route.kind) {
      case 'ingest':
        return await this.ingest(request)
      case 'read':
        return this.readPage(url)
      case 'stats':
        return this.stats(parsed.route)
    }
  }

  /**
   * One ingest is one SQLite transaction (spec § 4): a request answered `200`
   * has every one of its lines durably stored, counted as a duplicate, or
   * recorded as rejected, and a request that throws stores none of them.
   *
   * Content never makes the server refuse the body (spec § 3) — a sender
   * whose queue holds one bad line must not be stuck behind it forever, so a
   * well-formed request is always `200` and the bad line is counted as
   * rejected.
   */
  private async ingest(request: Request): Promise<Response> {
    const declared = request.headers.get('content-length')
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
      return jsonError(413, 'body over 8 MiB')
    }

    const body = await request.text()
    if (byteLength(body) > MAX_BODY_BYTES) return jsonError(413, 'body over 8 MiB')

    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const receivedAt = Date.now()
    let accepted = 0
    let duplicates = 0
    let rejected = 0

    this.ctx.storage.transactionSync(() => {
      // Reset inside the closure: a transaction the runtime retries must not
      // fold the abandoned attempt's counts into the one that commits.
      accepted = 0
      duplicates = 0
      rejected = 0

      for (const raw of lines) {
        const size = byteLength(raw)
        if (size > MAX_LINE_BYTES) {
          this.recordRejected(receivedAt, `too_large:${size}`, raw)
          rejected += 1
          continue
        }

        const record = classifyStoredLine(raw, NO_HOME)
        if (record.status === 'invalid') {
          this.recordRejected(receivedAt, `invalid:${record.reason}`, raw)
          rejected += 1
          continue
        }

        // Spec § 3: an event's identity is `recordIdentity`'s answer for the
        // object being stored — `event_id` for a `schema: 2` line, the
        // `run_id`/`seq` pair for a `schema: 1` one. A validated line is
        // identified from the validated event itself, so the stored row and
        // its identity can never be read off two different objects; a line
        // whose schema version this build does not know has only its raw
        // form, and `classifyStoredLine` already read the same function over
        // it.
        const identity = record.status === 'ok' ? recordIdentity(record.event) : record.identity
        if (identity === null) {
          this.recordRejected(receivedAt, 'no_identity', raw)
          rejected += 1
          continue
        }

        // `ok` stores the re-redacted line the read boundary produced;
        // `unknown_version` stores the line verbatim — a newer sender talking
        // to an older server loses nothing, and a line this build cannot
        // validate is also one it must not rewrite.
        const line = record.status === 'ok' ? record.postLine : record.raw
        const ts = record.status === 'ok' ? record.event.meta.ts : timestampOf(raw)

        // `RETURNING seq` yields a row only when the insert actually stored
        // one, so a resend of an already-stored identity is counted as a
        // duplicate rather than mistaken for a new event.
        const inserted = this.sql
          .exec(
            `INSERT OR IGNORE INTO events (event_id, status, ts, received_at, line)
             VALUES (?, ?, ?, ?, ?) RETURNING seq`,
            identity,
            record.status,
            ts,
            receivedAt,
            line
          )
          .toArray()

        if (inserted.length > 0) accepted += 1
        else duplicates += 1
      }
    })

    return Response.json({ accepted, duplicates, rejected, last_seq: this.lastSeq() })
  }

  private recordRejected(receivedAt: number, reason: string, raw: string): void {
    this.sql.exec(
      'INSERT INTO rejected (received_at, reason, line) VALUES (?, ?, ?)',
      receivedAt,
      reason,
      truncateToBytes(raw, REJECTED_LINE_BYTES)
    )
  }

  /**
   * A page of stored events after `after`, in `seq` order, at most `limit`
   * (default and maximum `1000`). `vinaya-log-next-after` carries the `seq`
   * to pass as `after` for the next page; an empty body means the reader is
   * caught up.
   */
  private readPage(url: URL): Response {
    const after = parseNonNegativeInteger(url.searchParams.get('after'), 0)
    if (after === 'invalid') return jsonError(400, 'after must be a non-negative integer')

    const requested = parseNonNegativeInteger(url.searchParams.get('limit'), READ_LIMIT_MAX)
    if (requested === 'invalid' || requested === 0) return jsonError(400, 'limit must be a positive integer')
    const limit = Math.min(requested, READ_LIMIT_MAX)

    const rows = this.sql
      .exec<{ seq: number; status: string; line: string }>(
        'SELECT seq, status, line FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
        after,
        limit
      )
      .toArray()

    // `line` is already a JSON document, so the envelope is assembled by
    // concatenation rather than parsed and re-serialized once per row.
    const body = rows
      .map((row) => `{"seq":${row.seq},"status":${JSON.stringify(row.status)},"event":${row.line}}\n`)
      .join('')
    const last = rows[rows.length - 1]
    const nextAfter = last === undefined ? after : Number(last.seq)

    return new Response(body, {
      headers: {
        'content-type': 'application/x-ndjson',
        'vinaya-log-next-after': String(nextAfter)
      }
    })
  }

  /**
   * What this repository holds, so the free plan's storage ceiling (spec § 2)
   * is visible long before it arrives.
   *
   * `events` and `rejected` are `MAX(rowid)`, not `COUNT(*)`: rows are never
   * deleted here — the same invariant that lets `seq` skip AUTOINCREMENT — so
   * the two are equal, and `MAX(rowid)` reads one row where `COUNT(*)` reads
   * every one of them. At eighteen months of the measured volume a counting
   * scan would be millions of row reads for one stats call, against a daily
   * read allowance of five million. A later change that deletes rows (the
   * archiving § 2 names as the planned answer to the storage ceiling) has to
   * replace this with real counters in the same change.
   */
  private stats(route: Route): Response {
    const lastSeq = this.lastSeq()
    const oldest = this.sql.exec<{ ts: string | null }>('SELECT ts FROM events ORDER BY seq ASC LIMIT 1').toArray()[0]
    const newest = this.sql.exec<{ ts: string | null }>('SELECT ts FROM events ORDER BY seq DESC LIMIT 1').toArray()[0]
    const lastRejected = this.sql.exec<{ id: number }>('SELECT id FROM rejected ORDER BY id DESC LIMIT 1').toArray()[0]

    return Response.json({
      repo: repoName(route),
      events: lastSeq,
      rejected: lastRejected === undefined ? 0 : Number(lastRejected.id),
      bytes: this.sql.databaseSize,
      oldest_ts: oldest?.ts ?? null,
      newest_ts: newest?.ts ?? null,
      last_seq: lastSeq
    })
  }

  /** The highest stored `seq`, or `0` when nothing is stored — one row read, never a scan. */
  private lastSeq(): number {
    const row = this.sql.exec<{ seq: number }>('SELECT seq FROM events ORDER BY seq DESC LIMIT 1').toArray()[0]
    return row === undefined ? 0 : Number(row.seq)
  }
}
