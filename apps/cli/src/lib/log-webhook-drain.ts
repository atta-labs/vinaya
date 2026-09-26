/**
 * The one delivery mechanism a `logs.url` server destination uses: it empties
 * a task's local retry queue into the configured server as ndjson, called by
 * `log-sink.ts` after every append (`apps/cli/specs/log.md` § The
 * destination), never batched at a round end and never reachable from a
 * one-shot CLI command any more.
 *
 * A queue that grew past one POST during a server outage still drains: the
 * queue is delivered from its HEAD in chunks of at most
 * `MAX_WEBHOOK_BODY_BYTES`, oldest first, and each chunk's bytes leave the
 * queue the moment a `2xx` acknowledges them, so a backlog of any size
 * catches up over as many POSTs as it takes. A chunk that fails ends the
 * drain with the queue holding exactly what the server never confirmed —
 * safe to retry on the next call, where the same head chunk is re-sent and
 * the server deduplicates it by the stable event identity the storage
 * contract already gives every line.
 *
 * Events the sink's rotation moved into the one `<name>.1.ndjson` backup slot
 * are delivered BEFORE the live file, so order survives a rotation instead of
 * the backup sitting unread until the next rotation overwrote it.
 *
 * Every line is re-validated and re-redacted through the storage contract's
 * `classifyStoredLine` before it is ever sent — nothing is posted this
 * function cannot vouch for. A line that fails that re-validation, carries a
 * schema version this build does not know, or is by itself larger than one
 * POST is moved to a `<name>.rejected.ndjson` file beside the queue, with its
 * reason, and the lines after it keep delivering: one bad line degrades one
 * line's worth of telemetry, never all of it.
 */

import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  linkSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { classifyStoredLine } from '@attalabs/aeg-core'
import { appendHardenedLine, outboxPathFor as sinkOutboxPathFor } from './log-sink.js'
import { GLOBAL_VINAYA_HOME } from './config.js'

/** One POST body capped well under common reverse-proxy/body-size limits (most default to 1-10 MiB). A queue larger than this is not a failure any more — it is delivered as however many chunks of at most this size it takes, each acknowledged and removed on its own. */
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024

/** Bounds the POST itself (round-2 security review, MEDIUM) — an unresponsive or intentionally slow endpoint would otherwise hang this call, and with it the round-end auto-flush and the whole dev-review-loop, indefinitely. Applies per chunk: a multi-chunk drain is bounded by this per POST, never once for the whole backlog. */
export const WEBHOOK_FETCH_TIMEOUT_MS = 30_000

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
function isSafeRepoSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment) && !segment.includes('..')
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

function isEnoent(err: unknown): boolean {
  return isErrnoCode(err, 'ENOENT')
}

/**
 * How long a lock may go WITHOUT OBSERVABLE PROGRESS before it is treated as
 * abandoned and stolen, rather than left to jam every future drain of this
 * queue file forever. It bounds the gap between a holder's own renewals, never
 * the total length of a drain: a healthy holder renews the lock before every
 * chunk it POSTs (`renewDrainLock`), and a single chunk is itself bounded by
 * `WEBHOOK_FETCH_TIMEOUT_MS`, so this leaves a healthy holder a factor of four
 * of margin no matter how many chunks or buckets its drain turns out to need.
 *
 * Sizing it against the total drain instead would be wrong in both directions,
 * and was: a drain covers up to three buckets (a leftover one, the rotation
 * backup slot, the live file), each of which can need several chunks, so a
 * slow-but-responding endpoint could hold this lock legitimately for many
 * times one chunk's timeout — and a second process would then steal the lock
 * from a holder that was still actively delivering, leaving both of them
 * reading and truncating the same bucket. No fixed multiple of one chunk's
 * timeout can be both large enough for an honest backlog and small enough to
 * free a genuinely dead holder promptly; only renewal separates the two.
 */
export const WEBHOOK_DRAIN_LOCK_STALE_MS = 4 * WEBHOOK_FETCH_TIMEOUT_MS

function tryCreateLock(lockPath: string, token: string): boolean {
  try {
    // The outbox directory may not exist yet — nothing has appended to this
    // task's queue file before; `O_CREAT` on the lock file itself never
    // creates a missing parent, so it must be made here first, same 0o700
    // mode `log-sink.ts`'s own `appendLine` already uses.
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
    const fd = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    try {
      writeSync(fd, `${token}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    if (isErrnoCode(err, 'EEXIST')) return false
    throw err
  }
}

/**
 * Cross-process mutual exclusion for the read-then-truncate below (round-2
 * security review, BLOCKER) — two OS processes, each running their own
 * `log-sink.ts` instance against the SAME `<owner>-<repo>/<task>.ndjson`
 * queue file (`dev-review-loop.ts` runs the reviewer and security roles
 * inside one `Promise.all`, each with its own `vinaya` invocations), can
 * otherwise both read the queue, both POST, and both truncate — one
 * process's `writeFileSync(path, tail)` silently discarding a line the
 * other appended in the gap, or both processes double-posting the same
 * lines. A `.flush-lock` sibling file, created with `O_EXCL` (atomic — the
 * filesystem picks exactly one winner, the same primitive
 * `control-store/local.ts` already uses for its own exclusive claims),
 * serializes the two. It is held for the WHOLE drain — every chunk of the
 * backup slot and of the live file — so a multi-chunk catch-up is as
 * exclusive as a single-chunk one ever was. A caller that loses the race
 * never blocks: it returns immediately and the caller treats that exactly
 * like "nothing to flush this call" — the file is untouched, and the NEXT
 * event's own drain (this process's chained one, or another process's)
 * retries, so delivery still catches up in order, just not on this exact
 * call.
 */
export function acquireDrainLock(lockPath: string): string | null {
  // A token unique to THIS acquisition, never the pid alone: two flushes in
  // one process (the default sink and a dispatch's own sink) share a pid, so
  // a pid cannot tell a caller's own lock from one another caller in the
  // same process took over after it went stale.
  const token = `${process.pid}:${randomUUID()}`
  if (tryCreateLock(lockPath, token)) return token
  let observedMtimeMs: number
  try {
    observedMtimeMs = statSync(lockPath).mtimeMs
  } catch (err) {
    if (!isEnoent(err)) throw err
    // The lock vanished between the failed create above and this stat — its
    // holder just finished. One more attempt rather than giving up here.
    return tryCreateLock(lockPath, token) ? token : null
  }
  if (Date.now() - observedMtimeMs <= WEBHOOK_DRAIN_LOCK_STALE_MS) return null
  // Claim the stale lock atomically. A rename moves the file for exactly one
  // contender; every other contender's rename finds nothing and backs off —
  // never the unlink-then-create two contenders could both complete, each
  // then believing it holds the lock.
  const claimed = `${lockPath}.claimed-${randomUUID()}`
  try {
    renameSync(lockPath, claimed)
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
  let claimedMtimeMs: number | null = null
  try {
    claimedMtimeMs = statSync(claimed).mtimeMs
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  if (claimedMtimeMs !== observedMtimeMs) {
    // What moved is not the lock this caller judged stale — another
    // contender claimed that one and created a fresh lock in between. Put the
    // fresh lock back untouched and back off.
    try {
      linkSync(claimed, lockPath)
    } catch (err) {
      if (!isErrnoCode(err, 'EEXIST')) throw err
    }
    try {
      unlinkSync(claimed)
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
    return null
  }
  unlinkSync(claimed)
  return tryCreateLock(lockPath, token) ? token : null
}

/**
 * Exported for `log-webhook-drain.test.ts` — verifies ownership before
 * deleting (round-3 security review, MEDIUM). A holder stalled past
 * `WEBHOOK_DRAIN_LOCK_STALE_MS` (plausible on a resource-contended host, not
 * only a genuine crash) can have `acquireDrainLock` steal its lock out from
 * under it; that holder's own `finally` still runs once it resumes, and an
 * unconditional unlink there would delete the NEW owner's still-active lock
 * — reopening the exact double-post/lost-line race this lock exists to
 * prevent, and letting a third caller acquire concurrently with the second.
 * Reading the token back and refusing to unlink a lock that does not carry
 * the caller's own acquisition token closes that — a token, not the pid,
 * since a second flush in the SAME process shares the pid: a stolen lock is
 * the new owner's alone to release, and the original holder's own release
 * becomes a no-op instead of a false teardown.
 */
/**
 * Marks progress on a lock this caller still holds, and reports whether it
 * still holds it. Two jobs in one read, deliberately: the mtime bump is what
 * keeps `WEBHOOK_DRAIN_LOCK_STALE_MS` a bound on idleness rather than on total
 * drain length, and the token comparison is what tells a holder its lock was
 * stolen anyway — after a genuine stall long enough to look dead, or a clock
 * jump. `false` means another acquisition owns this queue now, and the caller
 * must stop touching its files at once: the bucket is already renamed aside
 * under the private draining name with every acknowledged chunk already cut
 * from its head, so the new owner picks it up exactly where this one left off,
 * in order and with nothing posted twice.
 */
export function renewDrainLock(lockPath: string, token: string): boolean {
  let holder: string
  try {
    holder = readFileSync(lockPath, 'utf8').trim()
  } catch (err) {
    if (!isEnoent(err)) throw err
    // The lock is gone entirely — a takeover removed it, or an operator did.
    return false
  }
  if (holder !== token) return false
  const now = new Date()
  try {
    utimesSync(lockPath, now, now)
  } catch (err) {
    if (!isEnoent(err)) throw err
    return false
  }
  return true
}

export function releaseDrainLock(lockPath: string, token: string): void {
  try {
    const holder = readFileSync(lockPath, 'utf8').trim()
    if (holder !== token) return
    unlinkSync(lockPath)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
}

/**
 * What one drain did. `flushed` is true when the queue shrank at all on this
 * call — at least one chunk acknowledged, or at least one line set aside —
 * and false when nothing moved (an empty or missing queue, or a caller that
 * lost the cross-process lock). The counts are totals across every chunk and
 * both files this drain touched, so a caller reading `chunks` sees how many
 * POSTs a catch-up actually took.
 */
export type WebhookDrainOutcome = {
  flushed: boolean
  /** Lines the server acknowledged with a `2xx`. */
  lineCount: number
  /** Body bytes the server acknowledged, summed over the chunks it accepted. */
  bytes: number
  /** POSTs the server accepted. */
  chunks: number
  /** Lines moved to the rejected file, which are never posted. */
  rejected: number
}

export type WebhookDrainErrorCode =
  | 'log-webhook-drain-symlink'
  | 'log-webhook-drain-rejected-write'
  | 'log-webhook-drain-lock-lost'
  | 'log-webhook-drain-failed'

/** The one thrown-error shape `drainOutboxToWebhook` ever raises — never `process.exit`. */
export class WebhookDrainError extends Error {
  readonly code: WebhookDrainErrorCode
  constructor(code: WebhookDrainErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** The one rotation slot `log-sink.ts`'s own `appendLine` moves a full queue file into, derived the same way it derives it. */
function backupPathFor(queuePath: string): string {
  return queuePath.replace(/\.ndjson$/, '.1.ndjson')
}

/**
 * The one private name every bucket of the queue — the rotation backup slot
 * AND the live file itself — is renamed to for the duration of its own drain.
 * Nothing but a drain ever opens this name, and that is what makes removing
 * bytes safe at all.
 *
 * `log-sink.ts`'s append and its rotation both act on `<name>.ndjson`, and
 * neither takes this module's drain lock — an append must never wait on a
 * network call. So a drain that removed bytes from a shared path could have
 * that path renamed out from under it at any moment, including while a chunk
 * is in flight (up to `WEBHOOK_FETCH_TIMEOUT_MS`): the rotation moves the
 * file this drain is part-way through to `<name>.1.ndjson` and creates a
 * fresh one at the same path, and the next byte removal then truncates THAT
 * file using offsets computed against the old one — destroying every line
 * appended since, while the bytes the server had already acknowledged sit in
 * the new backup slot waiting to be posted a second time. A queue big enough
 * to need several chunks is by definition near the rotation cap, so this is
 * the ordinary case of an outage recovery, not a remote one.
 *
 * Renaming the bucket aside first removes the shared path from the drain
 * entirely: appends land on a fresh `<name>.ndjson` this drain never reads or
 * writes, and the next drain delivers them.
 *
 * Exactly one such file exists at a time, and it always holds the oldest
 * undelivered events: a bucket is renamed in only after the previous one has
 * been delivered and unlinked, and every failure throws before the next
 * rename, so nothing this drain has claimed can be overwritten by anything —
 * a rotation, or another bucket's own claim. A drain that dies leaves this
 * file for the next drain, which delivers it before anything newer.
 *
 * What this does NOT protect is a bucket nobody has claimed yet. `appendLine`
 * replaces `<name>.1.ndjson` on every rotation, unconditionally and without
 * the drain lock, so a batch sitting in that slot is destroyed if a rotation
 * arrives before a drain claims it — which is what happens while the server
 * is refusing, since a failed drain throws before it ever reaches the slot.
 * That is the rotation's own single-slot retention policy, unchanged by this
 * module and reported rather than silent: `log-sink.ts`'s
 * `reportRotationOverflow` names the identities each overwrite destroys.
 * Delivering that slot when a drain does reach it, as this module now does,
 * strictly reduces that loss; removing it altogether would mean the rotation
 * keeping more than one slot, and so is a change to the retention policy
 * rather than to this drain.
 */
function drainingPathFor(queuePath: string): string {
  return queuePath.replace(/\.ndjson$/, '.draining.ndjson')
}

/** Where a line the storage contract cannot vouch for is kept, with its reason — beside the queue, under the same machine-local outbox directory, never in the repository. */
function rejectedPathFor(queuePath: string): string {
  return queuePath.replace(/\.ndjson$/, '.rejected.ndjson')
}

// One visible warning per PROCESS for a set-aside line (O3) — the same bound
// the sink's own `warnOnce` keeps, and a separate flag rather than the sink's,
// so a rejection is never swallowed by an unrelated earlier sink warning (nor
// the reverse). A rejected line is a real, rare fault an operator must see
// once; it is not a per-line stream that could spam a gate's output.
let rejectionWarnedThisProcess = false
function warnRejectionOnce(message: string): void {
  if (rejectionWarnedThisProcess) return
  rejectionWarnedThisProcess = true
  try {
    process.stderr.write(message)
  } catch {
    // Telemetry never fails the run producing it, not even on its own warning.
  }
}

/** One queue line, with the byte offset just past its own terminator — the coordinate head removal needs and a plain `split('\n')` throws away. */
type QueueLine = { raw: string; end: number }

/**
 * Every non-empty line in `buf`, in file order, each carrying its own end
 * offset. Blank segments carry no line of their own: their bytes are absorbed
 * into the prefix of whichever line follows them, which is exact because
 * removal is always of a byte prefix. A trailing segment with no terminator
 * (a torn write) is still a line — it classifies as invalid and is set aside,
 * rather than being left at the head to block every future drain.
 */
function queueLines(buf: Buffer): QueueLine[] {
  const lines: QueueLine[] = []
  let start = 0
  for (let i = 0; i < buf.byteLength; i++) {
    if (buf[i] !== 0x0a) continue
    if (i > start) lines.push({ raw: buf.toString('utf8', start, i), end: i + 1 })
    start = i + 1
  }
  if (start < buf.byteLength) lines.push({ raw: buf.toString('utf8', start), end: buf.byteLength })
  return lines
}

/**
 * Removes exactly `cut` bytes from the head of the bucket being drained. This
 * only ever runs against the private `drainingPathFor` file, which no
 * producer can open, so the bytes at `cut` are always the ones this drain
 * planned and the rewrite can lose nothing — the guarantee comes from the
 * rename, not from keeping a read-then-rewrite window narrow. It is done per
 * acknowledged chunk rather than once at the end so that a drain killed
 * part-way never re-sends what the server already took.
 */
function removeQueueHead(path: string, cut: number): void {
  const remaining = readFileSync(path)
  writeFileSync(path, remaining.subarray(Math.min(cut, remaining.byteLength)))
}

/**
 * `null` when `path` does not exist, else its size in bytes; throws when it
 * exists and is not a regular file. Checked BEFORE any rename, so a planted
 * symlink or FIFO is refused where it stands rather than moved to the private
 * draining name, where it would refuse every later drain instead.
 */
function queueBucketSize(path: string): number | null {
  let lstat: ReturnType<typeof lstatSync> | undefined
  try {
    lstat = lstatSync(path)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  if (lstat === undefined) return null
  if (!lstat.isFile()) {
    throw new WebhookDrainError(
      'log-webhook-drain-symlink',
      `log webhook drain: outbox target is not a regular file (symlink, FIFO, or similar) — refusing to read: ${path}`
    )
  }
  return Number(lstat.size)
}

/** Reads `path`, or `null` when it does not exist; throws when it exists and is not a regular file, which is a planted target, never a queue. */
function readQueueFile(path: string): Buffer | null {
  if (queueBucketSize(path) === null) return null
  return readFileSync(path)
}

/**
 * Sets one line aside with its reason, in the same hardened append the queue
 * itself is written with (`log-sink.ts`'s `appendHardenedLine`: `0o700`
 * directory, `O_NOFOLLOW`, `0o600`) — a rejected line is still telemetry, so
 * it is kept, never dropped. An append that cannot be made ends the drain
 * instead: the line stays in the queue, where the next attempt finds it,
 * rather than being removed with nowhere to have gone.
 */
function rejectLine(rejectedPath: string, reason: string, status: string, identity: string | null, raw: string): void {
  const record = JSON.stringify({
    rejected_at: new Date().toISOString(),
    status,
    reason,
    identity,
    bytes: Buffer.byteLength(raw, 'utf8'),
    raw
  })
  const failure = appendHardenedLine(rejectedPath, `${record}\n`)
  if (failure !== null) {
    throw new WebhookDrainError(
      'log-webhook-drain-rejected-write',
      `log webhook drain: a queued line failed re-validation (${reason}) and could not be set aside in ${rejectedPath} — ${failure}; the line stays queued`
    )
  }
  warnRejectionOnce(
    `vinaya: log delivery set a queued line aside in ${rejectedPath} — ${reason}; later lines keep delivering\n`
  )
}

async function postChunk(
  webhookUrl: string,
  headers: Record<string, string> | undefined,
  body: string,
  fetchTimeoutMs: number,
  chunksAlreadyDelivered: number
): Promise<void> {
  const delivered = chunksAlreadyDelivered > 0 ? ` after delivering ${chunksAlreadyDelivered} chunk(s)` : ''
  let response: Response
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson', ...headers },
      body,
      signal: AbortSignal.timeout(fetchTimeoutMs)
    })
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? `timed out after ${fetchTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err)
    throw new WebhookDrainError(
      'log-webhook-drain-failed',
      `log webhook drain: POST to ${webhookUrl} failed${delivered}: ${reason}`
    )
  }
  if (!response.ok) {
    throw new WebhookDrainError(
      'log-webhook-drain-failed',
      `log webhook drain: POST to ${webhookUrl} returned ${response.status} ${response.statusText}${delivered}`
    )
  }
}

type DrainTotals = { lineCount: number; bytes: number; chunks: number; rejected: number }

type DrainArgs = {
  rejectedPath: string
  webhookUrl: string
  headers: Record<string, string> | undefined
  fetchTimeoutMs: number
  totals: DrainTotals
  /**
   * Marks progress on this drain's own lock and throws if the lock is no
   * longer held. Called before every POST and before every bucket claim, so a
   * long-but-healthy drain is never mistaken for a dead one, and a drain that
   * really did lose its lock stops before it can write alongside the new
   * owner.
   */
  keepLock: () => void
}

/**
 * Delivers one queue file from its head, in chunks of at most
 * `MAX_WEBHOOK_BODY_BYTES`, removing each chunk's bytes as soon as a `2xx`
 * acknowledges them. Returns the number of bytes of the original read this
 * call removed; throws on the first chunk the server does not accept, with
 * every earlier chunk already delivered and already gone from the queue.
 */
async function drainQueueFile(args: DrainArgs & { path: string }): Promise<void> {
  const { path, rejectedPath, webhookUrl, headers, fetchTimeoutMs, totals } = args
  const buf = readQueueFile(path)
  if (buf === null || buf.byteLength === 0) return
  const lines = queueLines(buf)
  if (lines.length === 0) {
    // Nothing but terminators — no line to deliver, and no reason to leave
    // the bytes at the head of every future drain either.
    removeQueueHead(path, buf.byteLength)
    return
  }

  // `removed` and `pendingEnd` are both offsets into the buffer read above;
  // `removed` is what has already been cut from the head, so a cut is always
  // `pendingEnd - removed` in the file's own current coordinates.
  let removed = 0
  let pendingEnd = 0
  let chunk: string[] = []
  let chunkBytes = 0

  const deliverChunk = async (): Promise<void> => {
    const body = `${chunk.join('\n')}\n`
    // Renewed immediately before the POST, never after: the POST is the one
    // step long enough to matter, so this is what keeps the gap between two
    // renewals inside one chunk's own timeout.
    args.keepLock()
    await postChunk(webhookUrl, headers, body, fetchTimeoutMs, totals.chunks)
    totals.chunks += 1
    totals.lineCount += chunk.length
    totals.bytes += Buffer.byteLength(body, 'utf8')
    removeQueueHead(path, pendingEnd - removed)
    removed = pendingEnd
    chunk = []
    chunkBytes = 0
  }

  /**
   * Whatever is already accumulated is delivered FIRST, so a line being set
   * aside is always at the head of the queue and its bytes leave immediately
   * after it lands in the rejected file. The gap in which a crash could make
   * the next drain classify and file the same bad line a second time is then
   * two adjacent statements rather than a chunk's whole network round trip —
   * a duplicate rejected record is still possible there, and is the side of
   * that trade-off to be on: the line is never removed before it is filed, so
   * it can be recorded twice but never lost. The cost is that a bad line ends
   * the chunk it interrupts, which is the right price for a rare fault.
   */
  const setAside = async (reason: string, status: string, identity: string | null, line: QueueLine): Promise<void> => {
    if (chunk.length > 0) await deliverChunk()
    rejectLine(rejectedPath, reason, status, identity, line.raw)
    totals.rejected += 1
    pendingEnd = line.end
    removeQueueHead(path, pendingEnd - removed)
    removed = pendingEnd
  }

  for (const line of lines) {
    const record = classifyStoredLine(line.raw, homedir())
    if (record.status !== 'ok') {
      await setAside(record.reason, record.status, record.identity, line)
      continue
    }
    const lineBytes = Buffer.byteLength(record.postLine, 'utf8') + 1
    if (lineBytes > MAX_WEBHOOK_BODY_BYTES) {
      await setAside(
        `one line is ${lineBytes} byte(s), over the ${MAX_WEBHOOK_BODY_BYTES}-byte per-POST cap — no chunking can carry it`,
        'too_large',
        record.identity,
        line
      )
      continue
    }
    if (chunk.length > 0 && chunkBytes + lineBytes > MAX_WEBHOOK_BODY_BYTES) await deliverChunk()
    chunk.push(record.postLine)
    chunkBytes += lineBytes
    pendingEnd = line.end
  }

  // Every line of the read is accounted for by here, so the last cut takes
  // the whole buffer — including any terminator-only bytes trailing the final
  // line, which no line's own `end` covers and which would otherwise sit at
  // the head of every future drain.
  pendingEnd = buf.byteLength
  if (chunk.length > 0) {
    await deliverChunk()
    return
  }
  if (pendingEnd > removed) removeQueueHead(path, pendingEnd - removed)
}

/**
 * Renames one bucket — the rotation backup slot, or the live queue file — to
 * the private draining name and delivers it there, removing the file once
 * every line has been delivered or set aside. Called only when no draining
 * file is present, so the rename can never overwrite an undelivered backlog;
 * a drain that cannot finish throws, leaving the file for the next one.
 *
 * An empty or absent bucket is left exactly as it is: the live file is
 * re-created by the next append anyway, and renaming it on every event would
 * be churn for no delivery.
 */
async function drainRenamedAside(args: DrainArgs, livePath: string, source: string): Promise<void> {
  args.keepLock()
  const draining = drainingPathFor(livePath)
  // Claimed by the rename ALONE — never a size check followed by a rename.
  // `renameSync` is atomic, so the bucket this drain goes on to deliver is
  // exactly the one the rename moved, whatever a concurrent rotation does to
  // `source` on either side of it. A check-then-act pair let a rotation land
  // in the gap and leave the drain reasoning about content it no longer held:
  // it had measured one file and would then deliver another. An absent bucket
  // is the ordinary case for the backup slot, so `ENOENT` is a return, not an
  // error. A bucket that exists but is not a regular file is refused by the
  // read below, after the rename rather than before it — the atomicity of the
  // claim is worth more than refusing a planted target at its original path,
  // and either way that target jams this queue's drains until an operator
  // removes it.
  try {
    renameSync(source, draining)
  } catch (err) {
    if (isEnoent(err)) return
    throw err
  }
  await drainQueueFile({ ...args, path: draining })
  unlinkSync(draining)
}

/**
 * Reads `outboxTask`'s own local outbox (`null` for the `subject.issue:
 * null` case — an unattributed process still delivers) and delivers it to
 * `webhookUrl`: the rotation backup slot first, then the live queue file,
 * each from its head in chunks of at most `MAX_WEBHOOK_BODY_BYTES`, with
 * every chunk's bytes leaving the queue as soon as a `2xx` acknowledges
 * them. Every line is validated and re-redacted through the storage
 * contract's `classifyStoredLine` first; a line it cannot vouch for, or one
 * larger than a single POST, is moved to the rejected file beside the queue
 * and the lines after it keep delivering.
 *
 * Stops at the first chunk the server does not accept, leaving the queue
 * holding exactly what was never confirmed — the next call re-sends the same
 * head chunk, which the server deduplicates by the stable event identity
 * every line carries.
 */
export async function drainOutboxToWebhook(
  outboxTask: number | null,
  webhookUrl: string,
  headers?: Record<string, string>,
  /** Test-only override of `WEBHOOK_FETCH_TIMEOUT_MS` — every production call site omits this and gets the real bound; a test proving the timeout fires does not have to pay the real 30s to observe it. */
  fetchTimeoutMs: number = WEBHOOK_FETCH_TIMEOUT_MS
): Promise<WebhookDrainOutcome> {
  const resolved = await resolveRepo()
  const repo = resolved && isSafeRepoSegment(resolved.owner) && isSafeRepoSegment(resolved.repo) ? resolved : null
  const outboxRoot = () => join(GLOBAL_VINAYA_HOME, 'outbox')
  const path = sinkOutboxPathFor({ outboxRoot }, repo, outboxTask)

  const lockPath = `${path}.flush-lock`
  const lockToken = acquireDrainLock(lockPath)
  const totals: DrainTotals = { lineCount: 0, bytes: 0, chunks: 0, rejected: 0 }
  if (lockToken === null) return { flushed: false, ...totals }
  try {
    // A holder that has lost its lock stops at the next renewal point rather
    // than writing alongside whoever took it: every acknowledged chunk is
    // already cut from the bucket's head, so the new owner resumes from
    // exactly there, in order, with nothing posted twice.
    const keepLock = (): void => {
      if (renewDrainLock(lockPath, lockToken)) return
      throw new WebhookDrainError(
        'log-webhook-drain-lock-lost',
        `log webhook drain: this drain's lock on ${lockPath} was taken over by another process — stopping here; that process delivers the rest`
      )
    }
    const shared: DrainArgs = {
      rejectedPath: rejectedPathFor(path),
      webhookUrl,
      headers,
      fetchTimeoutMs,
      totals,
      keepLock
    }
    // Oldest bucket first, one at a time: whatever a previous drain left
    // behind, then the rotation backup slot, then the live file — each
    // delivered and removed before the next is renamed into its place, so the
    // one private name is never overwritten and the order events were
    // produced in is never inverted.
    const draining = drainingPathFor(path)
    if (queueBucketSize(draining) !== null) {
      keepLock()
      await drainQueueFile({ ...shared, path: draining })
      unlinkSync(draining)
    }
    await drainRenamedAside(shared, path, backupPathFor(path))
    await drainRenamedAside(shared, path, path)
    return { flushed: totals.chunks > 0 || totals.rejected > 0, ...totals }
  } finally {
    releaseDrainLock(lockPath, lockToken)
  }
}
