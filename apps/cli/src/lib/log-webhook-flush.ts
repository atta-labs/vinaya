/**
 * A generic HTTP alternative to `flushOutbox`'s GitHub-comment posting
 * (`./log-flush.js`) — one POST of a task's outbox, as ndjson, to any
 * endpoint that accepts one. No GitHub account or `gh` auth needed on the
 * receiving end — the point of this option is a destination an adopter can
 * point at with nothing more than a URL. There is no forge read, no comment
 * chunking, and no marker-based idempotent retry — those exist in
 * `flushOutbox` specifically to work around GitHub's own per-comment size
 * limit and to detect a lost acknowledgement against GitHub's comment
 * history; a generic webhook has no equivalent to read back. Truncation
 * follows only a confirmed 2xx response, the same fail-closed rule
 * `flushOutbox` uses: a failed POST leaves the outbox untouched, safe to
 * retry on the next call.
 *
 * Two callers: `logPublish.webhookUrl` (`./config.js`)'s one-shot
 * `vinaya log flush`/`log collect-artifact` posting mode, and `log-sink.ts`'s
 * own live per-event drain of a configured `logs.url` server destination —
 * called after every append to the local retry queue (`apps/cli/specs/log.md`
 * § The destination), never batched at a round end.
 */

import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { classifyStoredLine } from '@attalabs/aeg-core'
import { outboxPathFor as sinkOutboxPathFor } from './log-sink.js'
import { GLOBAL_VINAYA_HOME } from './config.js'

/** One POST body capped well under common reverse-proxy/body-size limits (most default to 1-10 MiB) — a task that outgrows this should flush more often, not have this function silently start splitting one webhook call into several with no marker to dedupe them against on retry. */
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024

/** Bounds the POST itself (round-2 security review, MEDIUM) — an unresponsive or intentionally slow endpoint would otherwise hang this call, and with it the round-end auto-flush and the whole dev-review-loop, indefinitely. */
export const WEBHOOK_FETCH_TIMEOUT_MS = 30_000

// Mirrors `log-flush.ts`'s own `SAFE_PATH_SEGMENT`/`isSafeRepoSegment` — not
// exported from there, so the same narrow guard is repeated here rather than
// widening that file's export surface for a one-line check.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
function isSafeRepoSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment) && !segment.includes('..')
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

export type WebhookFlushOutcome = { flushed: false } | { flushed: true; lineCount: number; bytes: number }

export type WebhookFlushErrorCode =
  | 'log-webhook-flush-symlink'
  | 'log-webhook-flush-corrupt-line'
  | 'log-webhook-flush-too-large'
  | 'log-webhook-flush-failed'

/** The one thrown-error shape `flushOutboxToWebhook` ever raises — never `process.exit`, mirroring `LogFlushError`. */
export class WebhookFlushError extends Error {
  readonly code: WebhookFlushErrorCode
  constructor(code: WebhookFlushErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Reads `outboxTask`'s own local outbox (`null` for the `subject.issue:
 * null` case — an unattributed process still delivers), validates and
 * re-redacts every line through the storage contract's `classifyStoredLine`
 * (the same transport-boundary check `flushOutbox` runs before a GitHub
 * post — fail closed on any corrupt or unknown-version line, never post data
 * this function cannot vouch for), then POSTs the survivors as one ndjson
 * body to `webhookUrl`. Truncates the outbox to exactly whatever was
 * appended to the live file since the read started (a concurrent writer's
 * line) — every line present at read time was either posted or the whole
 * call threw before posting anything, so there is never a partially-posted
 * remainder to preserve, unlike `flushOutbox`'s per-chunk case.
 */
export async function flushOutboxToWebhook(
  outboxTask: number | null,
  webhookUrl: string,
  headers?: Record<string, string>,
  /** Test-only override of `WEBHOOK_FETCH_TIMEOUT_MS` — every production call site omits this and gets the real bound; a test proving the timeout fires does not have to pay the real 30s to observe it. */
  fetchTimeoutMs: number = WEBHOOK_FETCH_TIMEOUT_MS
): Promise<WebhookFlushOutcome> {
  const resolved = await resolveRepo()
  const repo = resolved && isSafeRepoSegment(resolved.owner) && isSafeRepoSegment(resolved.repo) ? resolved : null
  const outboxRoot = () => join(GLOBAL_VINAYA_HOME, 'outbox')
  const path = sinkOutboxPathFor({ outboxRoot }, repo, outboxTask)

  let lstat: ReturnType<typeof lstatSync> | undefined
  try {
    lstat = lstatSync(path)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  if (lstat === undefined) return { flushed: false }
  if (!lstat.isFile()) {
    throw new WebhookFlushError(
      'log-webhook-flush-symlink',
      `log webhook flush: outbox target is not a regular file (symlink, FIFO, or similar) — refusing to read: ${path}`
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
      throw new WebhookFlushError(
        'log-webhook-flush-corrupt-line',
        `log webhook flush: outbox line ${i} failed schema re-validation — ${record.reason}`
      )
    }
    postLines.push(record.postLine)
  }

  const body = `${postLines.join('\n')}\n`
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookFlushError(
      'log-webhook-flush-too-large',
      `log webhook flush: outbox body is ${bytes} byte(s), over the ${MAX_WEBHOOK_BODY_BYTES}-byte per-call cap — flush more often to drain it.`
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
    throw new WebhookFlushError(
      'log-webhook-flush-failed',
      `log webhook flush: POST to ${webhookUrl} failed: ${reason}`
    )
  }
  if (!response.ok) {
    throw new WebhookFlushError(
      'log-webhook-flush-failed',
      `log webhook flush: POST to ${webhookUrl} returned ${response.status} ${response.statusText}`
    )
  }

  const liveNow = readFileSync(path)
  const tail = liveNow.subarray(Math.min(startOffset, liveNow.byteLength))
  writeFileSync(path, tail)

  return { flushed: true, lineCount: postLines.length, bytes }
}
