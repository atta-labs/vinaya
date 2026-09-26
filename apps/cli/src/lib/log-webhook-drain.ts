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
 * `classifyStoredLine` before it is ever sent, fail-closed on any corrupt or
 * unknown-version line — nothing is posted this function cannot vouch for.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  linkSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { classifyStoredLine } from '@attalabs/aeg-core'
import { outboxPathFor as sinkOutboxPathFor } from './log-sink.js'
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

/** A lock older than this was almost certainly abandoned by a holder that crashed mid-flush — normal completion always removes its own lock well before this — so it is stolen rather than left to jam every future drain of this queue file forever. Set well above `WEBHOOK_FETCH_TIMEOUT_MS`, the longest a healthy holder can legitimately still be inside the critical section. */
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
 * call — at least one chunk acknowledged —
 * and false when nothing moved (an empty or missing queue, or a caller that
 * lost the cross-process lock). The counts are totals across every chunk this
 * drain delivered, so a caller reading `chunks` sees how many POSTs a
 * catch-up actually took.
 */
export type WebhookDrainOutcome = {
  flushed: boolean
  /** Lines the server acknowledged with a `2xx`. */
  lineCount: number
  /** Body bytes the server acknowledged, summed over the chunks it accepted. */
  bytes: number
  /** POSTs the server accepted. */
  chunks: number
}

export type WebhookDrainErrorCode =
  | 'log-webhook-drain-symlink'
  | 'log-webhook-drain-corrupt-line'
  | 'log-webhook-drain-too-large'
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
 * The private name a backup slot is renamed to for the duration of its own
 * drain. The rotation in `log-sink.ts` does not take this module's drain lock
 * — it must never wait on a network call to append a line — so a rotation
 * landing mid-drain would otherwise `renameSync` a fresh, undelivered queue
 * file straight onto the backup this drain is part-way through removing bytes
 * from, and the next byte removal would cut into events that were never sent.
 * Moving the backup aside first makes that impossible: a rotation overwrites
 * `<name>.1.ndjson`, which by then holds nothing this drain is reading. A
 * drain that crashes leaves this file behind, and the next drain delivers it
 * first — older than the current backup, so still oldest-first.
 */
function drainingBackupPathFor(queuePath: string): string {
  return queuePath.replace(/\.ndjson$/, '.1.draining.ndjson')
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
 * Removes exactly `cut` bytes from the head of `path`, preserving everything
 * appended since. The read and the rewrite are adjacent statements on
 * purpose: another process's `O_APPEND` line landing between them is the one
 * way a line can still be lost, so that window stays as narrow as a
 * read-then-rewrite can be — a chunked drain takes this same narrow window
 * once per acknowledged chunk, never a wider one.
 */
function removeQueueHead(path: string, cut: number): void {
  const liveNow = readFileSync(path)
  writeFileSync(path, liveNow.subarray(Math.min(cut, liveNow.byteLength)))
}

/** Reads `path`, or `null` when it does not exist; throws when it exists and is not a regular file, which is a planted target, never a queue. */
function readQueueFile(path: string): Buffer | null {
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
  return readFileSync(path)
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

type DrainTotals = { lineCount: number; bytes: number; chunks: number }

/**
 * Delivers one queue file from its head, in chunks of at most
 * `MAX_WEBHOOK_BODY_BYTES`, removing each chunk's bytes as soon as a `2xx`
 * acknowledges them. Returns the number of bytes of the original read this
 * call removed; throws on the first chunk the server does not accept, with
 * every earlier chunk already delivered and already gone from the queue.
 */
async function drainQueueFile(args: {
  path: string
  webhookUrl: string
  headers: Record<string, string> | undefined
  fetchTimeoutMs: number
  totals: DrainTotals
}): Promise<void> {
  const { path, webhookUrl, headers, fetchTimeoutMs, totals } = args
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
    await postChunk(webhookUrl, headers, body, fetchTimeoutMs, totals.chunks)
    totals.chunks += 1
    totals.lineCount += chunk.length
    totals.bytes += Buffer.byteLength(body, 'utf8')
    removeQueueHead(path, pendingEnd - removed)
    removed = pendingEnd
    chunk = []
    chunkBytes = 0
  }

  for (const line of lines) {
    const record = classifyStoredLine(line.raw, homedir())
    if (record.status !== 'ok') {
      throw new WebhookDrainError(
        'log-webhook-drain-corrupt-line',
        `log webhook drain: an outbox line failed schema re-validation — ${record.reason}`
      )
    }
    const lineBytes = Buffer.byteLength(record.postLine, 'utf8') + 1
    if (lineBytes > MAX_WEBHOOK_BODY_BYTES) {
      throw new WebhookDrainError(
        'log-webhook-drain-too-large',
        `log webhook drain: one outbox line is ${lineBytes} byte(s), over the ${MAX_WEBHOOK_BODY_BYTES}-byte per-POST cap.`
      )
    }
    if (chunk.length > 0 && chunkBytes + lineBytes > MAX_WEBHOOK_BODY_BYTES) await deliverChunk()
    chunk.push(record.postLine)
    chunkBytes += lineBytes
    pendingEnd = line.end
  }

  // Every line of the read is accounted for by here, so the last cut takes
  // the whole buffer — including any terminator-only bytes trailing the final
  // line, which no line's own `end` covers and which would otherwise sit at
  // the head of every future drain. Bytes a concurrent writer appended past
  // this offset are preserved, exactly as they were before chunking.
  pendingEnd = buf.byteLength
  if (chunk.length > 0) {
    await deliverChunk()
    return
  }
  // Terminator-only bytes trailing the final line still have to leave.
  if (pendingEnd > removed) removeQueueHead(path, pendingEnd - removed)
}

/** Delivers the rotation backup slot, if there is one, before the live file — the events in it are older, and nothing else ever reads them. */
async function drainBackupSlot(args: {
  path: string
  webhookUrl: string
  headers: Record<string, string> | undefined
  fetchTimeoutMs: number
  totals: DrainTotals
}): Promise<void> {
  const draining = drainingBackupPathFor(args.path)
  const backup = backupPathFor(args.path)
  // A file left behind by a drain that crashed part-way through the backup
  // slot holds the oldest events of all, so it goes first — and it must be
  // finished before the current backup can be moved into its place. A drain
  // that returns has delivered or set aside every line it read, so the file
  // is empty by then; a drain that could not goes out through a throw
  // instead, leaving the file for the next attempt.
  if (existsSync(draining)) {
    await drainQueueFile({ ...args, path: draining })
    unlinkSync(draining)
  }
  if (!existsSync(backup)) return
  renameSync(backup, draining)
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
 * contract's `classifyStoredLine` first, fail-closed on any corrupt or
 * unknown-version line.
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
  const totals: DrainTotals = { lineCount: 0, bytes: 0, chunks: 0 }
  if (lockToken === null) return { flushed: false, ...totals }
  try {
    const shared = { webhookUrl, headers, fetchTimeoutMs, totals }
    await drainBackupSlot({ ...shared, path })
    await drainQueueFile({ ...shared, path })
    return { flushed: totals.chunks > 0, ...totals }
  } finally {
    releaseDrainLock(lockPath, lockToken)
  }
}
