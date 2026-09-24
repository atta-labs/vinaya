/**
 * The one delivery mechanism a `logs.url` server destination uses: one POST
 * of a task's local retry queue, as ndjson, to any HTTP endpoint that
 * accepts one — no GitHub account or `gh` auth needed on the receiving end.
 * Renamed from the tracker-posting-era `flushOutboxToWebhook`: there is no
 * GitHub comment path left to distinguish this from, so "drain" names what
 * it actually does — empty the local queue into the
 * configured server, called by `log-sink.ts` after every append
 * (`apps/cli/specs/log.md` § The destination), never batched at a round end
 * and never reachable from a one-shot CLI command any more.
 *
 * Truncation follows only a confirmed 2xx response — a failed POST leaves
 * the queue untouched, safe to retry on the next call — and every line is
 * re-validated and re-redacted through the storage contract's
 * `classifyStoredLine` before it is ever sent, fail-closed on any corrupt or
 * unknown-version line.
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

/** One POST body capped well under common reverse-proxy/body-size limits (most default to 1-10 MiB) — a task that outgrows this should flush more often, not have this function silently start splitting one webhook call into several with no marker to dedupe them against on retry. */
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024

/** Bounds the POST itself (round-2 security review, MEDIUM) — an unresponsive or intentionally slow endpoint would otherwise hang this call, and with it the round-end auto-flush and the whole dev-review-loop, indefinitely. */
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
 * serializes the two. A caller that loses the race never blocks: it
 * returns immediately and the caller treats that exactly like "nothing to
 * flush this call" — the file is untouched, and the NEXT event's own drain
 * (this process's chained one, or another process's) retries, so delivery
 * still catches up in order, just not on this exact call.
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

export type WebhookDrainOutcome = { flushed: false } | { flushed: true; lineCount: number; bytes: number }

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

/**
 * Reads `outboxTask`'s own local outbox (`null` for the `subject.issue:
 * null` case — an unattributed process still delivers), validates and
 * re-redacts every line through the storage contract's `classifyStoredLine`
 * — fail closed on any corrupt or unknown-version line, never post data this
 * function cannot vouch for — then POSTs the survivors as one ndjson body to
 * `webhookUrl`. Truncates the outbox to exactly whatever was appended to the
 * live file since the read started (a concurrent writer's line) — every
 * line present at read time was either posted or the whole call threw
 * before posting anything, so there is never a partially-posted remainder
 * to preserve.
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
  if (lockToken === null) return { flushed: false }
  try {
    let lstat: ReturnType<typeof lstatSync> | undefined
    try {
      lstat = lstatSync(path)
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
    if (lstat === undefined) return { flushed: false }
    if (!lstat.isFile()) {
      throw new WebhookDrainError(
        'log-webhook-drain-symlink',
        `log webhook drain: outbox target is not a regular file (symlink, FIFO, or similar) — refusing to read: ${path}`
      )
    }

    const buf = readFileSync(path)
    const startOffset = buf.byteLength
    const rawLines = buf
      .toString('utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    if (rawLines.length === 0) return { flushed: false }

    const postLines: string[] = []
    for (let i = 0; i < rawLines.length; i++) {
      const record = classifyStoredLine(rawLines[i] as string, homedir())
      if (record.status !== 'ok') {
        throw new WebhookDrainError(
          'log-webhook-drain-corrupt-line',
          `log webhook drain: outbox line ${i} failed schema re-validation — ${record.reason}`
        )
      }
      postLines.push(record.postLine)
    }

    const body = `${postLines.join('\n')}\n`
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > MAX_WEBHOOK_BODY_BYTES) {
      throw new WebhookDrainError(
        'log-webhook-drain-too-large',
        `log webhook drain: outbox body is ${bytes} byte(s), over the ${MAX_WEBHOOK_BODY_BYTES}-byte per-call cap — flush more often to drain it.`
      )
    }

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
        `log webhook drain: POST to ${webhookUrl} failed: ${reason}`
      )
    }
    if (!response.ok) {
      throw new WebhookDrainError(
        'log-webhook-drain-failed',
        `log webhook drain: POST to ${webhookUrl} returned ${response.status} ${response.statusText}`
      )
    }

    const liveNow = readFileSync(path)
    const tail = liveNow.subarray(Math.min(startOffset, liveNow.byteLength))
    writeFileSync(path, tail)

    return { flushed: true, lineCount: postLines.length, bytes }
  } finally {
    releaseDrainLock(lockPath, lockToken)
  }
}
