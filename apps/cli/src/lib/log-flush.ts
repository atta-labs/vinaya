/**
 * The flush's own body (task 3, Issue #482, O1) — moved verbatim out of
 * `apps/cli/src/commands/log.ts`'s `logFlushCommand`, which is now argv
 * parsing and process-exit translation around this one function. Posts a
 * target's outbox — written by `log()` (`./log-sink.js`) — as one or more
 * marked comments on an Issue or a PR, then truncates only the lines the
 * forge confirmed. `apps/cli/specs/log.md` § The flush is the durable
 * reference for the chunking/truncation contract this file implements;
 * this comment does not restate it.
 *
 * Never calls `process.exit` — every terminal outcome is either a returned
 * `LogFlushOutcome` or a thrown `LogFlushError`, so this function is safe to
 * call in-process from a long-running driver (O2: `dev-review-loop.ts`'s
 * round-end flush) as well as from the one-shot `vinaya log flush` command.
 */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { classifyStoredLine, extractIssue, type ForgeOp } from '@attalabs/aeg-core'
import { currentRunId, log, outboxPathFor as sinkOutboxPathFor, type LogEventInput } from './log-sink.js'
import { GLOBAL_VINAYA_HOME } from './config.js'

/** A comment is closed before adding the next line would push it past this (`apps/cli/specs/log.md`). */
const FORGE_COMMENT_MAX_CHARS = 65536

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

type ForgeWriteSignature = {
  event: 'validated' | 'refused' | 'written'
  op: ForgeOp
  target: { issue?: number; pr?: number }
}

/**
 * True iff the bytes appended to `path` since `priorSize` include a line
 * matching `expected` AND carrying `runId`. The `runId` check is
 * load-bearing, not decorative (code review, PR #439): "the file grew"
 * alone cannot tell this call's own fire-and-forget `log()` write apart
 * from an unrelated, concurrent `vinaya` process appending to the SAME
 * outbox at the same moment — two processes sharing an Issue's outbox is
 * the normal case this command's own truncation comment already accounts
 * for. Re-reads the whole grown region every poll, not just the newest
 * line, so a concurrent process's line landing before or after ours within
 * that region never hides ours. `runId` is a parameter (not read from
 * `currentRunId()` internally) so this correlation logic is directly
 * unit-testable against a decoy line with a different `run_id`.
 */
export function tailHasOwnLine(path: string, priorSize: number, runId: string, expected: ForgeWriteSignature): boolean {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return false
  }
  if (buf.byteLength <= priorSize) return false
  for (const raw of buf.subarray(priorSize).toString('utf8').split('\n')) {
    if (!raw) continue
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      continue
    }
    const o = obj as { meta?: { run_id?: unknown }; kind?: unknown; event?: unknown; op?: unknown; target?: unknown }
    if (
      o.meta?.run_id === runId &&
      o.kind === 'forge_write' &&
      o.event === expected.event &&
      o.op === expected.op &&
      JSON.stringify(o.target) === JSON.stringify(expected.target)
    ) {
      return true
    }
  }
  return false
}

/**
 * `log()` is fire-and-forget (`deps.resolveRepo().then(...)`, no returned
 * promise, by design — task 1's shipped, frozen interface) and its internal
 * `resolveRepo()` call is a real (if usually cache-hit) async boundary, not
 * a fixed number of microtask ticks — a `setImmediate`/`Promise` drain proved
 * unreliable across hosts (observed live: passed under `node` on the built
 * CLI, failed under `bun` running the TS source directly). Polling for THIS
 * call's own line (`tailHasOwnLine`, keyed on `currentRunId()`) to actually
 * land is the only signal that neither guesses at scheduling internals nor
 * mistakes a concurrent process's write for this one's.
 */
async function waitForOwnLine(
  path: string,
  priorSize: number,
  expected: ForgeWriteSignature,
  timeoutMs = 2000
): Promise<boolean> {
  const runId = currentRunId()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (tailHasOwnLine(path, priorSize, runId, expected)) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}

/**
 * `log()` fills `subject.issue` from `process.env.VINAYA_TASK`
 * (`log/envelope.ts`'s `issueFromTask`) — never from an argument. For this
 * call's line to land in the SAME outbox this function is about to
 * truncate, `VINAYA_TASK` is set to the flushed Issue for the duration of
 * the call, restored after — this holds identically whether the caller is
 * the one-shot command or an in-process, long-running driver (O2/O3): the
 * driver's own `VINAYA_TASK` is a live process env var this restores
 * exactly, never clobbers. Returns whether the write was confirmed landed
 * (`waitForOwnLine`) rather than throwing — a timeout is not necessarily
 * fatal (see call sites below): a bare `process.exit()` right after `log()`
 * would abandon the write mid-flight, but the caller decides what "not
 * confirmed" means for its own position in the flush.
 */
async function logForFlush(
  issueNumber: number,
  path: string,
  e: LogEventInput & ForgeWriteSignature
): Promise<boolean> {
  const prevTask = process.env.VINAYA_TASK
  process.env.VINAYA_TASK = String(issueNumber)
  const priorSize = sizeOf(path)
  try {
    log(e)
    return await waitForOwnLine(path, priorSize, { event: e.event, op: e.op, target: e.target })
  } finally {
    if (prevTask === undefined) delete process.env.VINAYA_TASK
    else process.env.VINAYA_TASK = prevTask
  }
}

// Mirrors `log-sink.ts`'s own `SAFE_PATH_SEGMENT`/`isSafeRepoSegment` — not
// exported from there (that file's diff for this task stays to the one
// `outboxPathFor` extraction), so the same narrow guard is repeated here
// rather than widening that module's export surface for a one-line check.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
function isSafeRepoSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment) && !segment.includes('..')
}

type FlushChunk = { runId: string; seqFrom: number; seqTo: number; body: string }

/** Thrown internally by `planFlush` when a single outbox line cannot fit in one comment even alone — never split across two. Caught and re-thrown as a `LogFlushError` before ever reaching a caller. */
class LineTooLargeError extends Error {
  readonly seq: number
  constructor(seq: number) {
    super(
      `log flush: outbox line at seq ${seq} is larger than FORGE_COMMENT_MAX_CHARS on its own — refusing to split a single line across two comments`
    )
    this.seq = seq
  }
}

/** Thrown internally by `parseOutboxLine` when a line fails full `LogEventSchema` re-validation — never posted, never trusted on faith. Caught and re-thrown as a `LogFlushError` before ever reaching a caller. */
class CorruptOutboxLineError extends Error {
  readonly index: number
  constructor(index: number, reason: string) {
    super(`log flush: outbox line ${index} failed schema re-validation — ${reason}`)
    this.index = index
  }
}

/** `runId`/`seq` for chunk planning; `postLine` is the re-redacted, re-serialized text actually posted — never the raw file bytes verbatim. */
type ParsedLine = { postLine: string; runId: string; seq: number }

/**
 * Re-validates a stored outbox line through the log storage contract's
 * read-back classifier (`classifyStoredLine`, `@attalabs/aeg-core`) — the
 * transport half of the append/read-page contract this GitHub adapter
 * implements (`packages/aeg-core/src/log/store.ts`; `apps/cli/specs/log.md` §
 * The storage contract). The classifier runs the FULL `LogEventSchema` (not
 * merely presence of `meta.run_id`/`meta.seq`), validates a `schema: 2`
 * line's provenance, and re-applies `redact()` at this second check-moment
 * before the text is ever posted publicly (security review, PR #439): the
 * on-disk file is trusted for its own append-time write, but a manually
 * edited line, a corrupted one, or a future gap in `redact.ts`'s coverage
 * must not slip through. This transport is deliberately fail-closed — a
 * corrupt line AND an unknown-schema-version line (one this build cannot
 * validate) both refuse the whole flush (`CorruptOutboxLineError`) rather
 * than post data this adapter cannot vouch for. That is the opposite of the
 * read-back reader's fail-open posture, which PRESERVES an unknown-version
 * record for diagnosis (O3): a diagnostic read keeps what it cannot parse, a
 * public post never emits it.
 */
function parseOutboxLine(raw: string, index: number): ParsedLine {
  const record = classifyStoredLine(raw, homedir())
  if (record.status !== 'ok') {
    throw new CorruptOutboxLineError(index, record.reason)
  }
  return { postLine: record.postLine, runId: record.runId, seq: record.seq }
}

/** Every `run_id:seq_from-seq_to` key a comment body on the target already carries — the flush's own `<!-- aeg:log:… -->` markers from a prior attempt. */
function extractLogMarkers(body: string): string[] {
  const re = /<!-- aeg:log:([A-Za-z0-9_.-]+):(\d+)-(\d+) -->/g
  return [...body.matchAll(re)].map((m) => `${m[1]}:${m[2]}-${m[3]}`)
}

/**
 * The set of chunk marker keys already posted on `targetId` — the on-forge
 * idempotency key that closes the "flush retries can repeat remotely accepted
 * batches" defect (O2, Issue #562's Boundary). A prior flush that posted a
 * chunk but died before truncating (a lost acknowledgement) leaves the
 * chunk's `<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->` marker on the
 * forge; the retry reads it here and acknowledges that chunk without posting
 * a second copy. Tolerant by design: a forge read failure returns the empty
 * set, so the flush falls back to its pre-fix behavior (post everything)
 * rather than blocking on a telemetry-side read — telemetry never blocks the
 * governed effect (the spec's own rule).
 */
function existingLogMarkers(op: ForgeOp, targetId: string): Set<string> {
  const markers = new Set<string>()
  try {
    const raw =
      op === 'pr.comment'
        ? gh(['pr', 'view', targetId, '--json', 'comments'])
        : gh(['issue', 'view', targetId, '--json', 'comments'])
    const parsed = JSON.parse(raw) as { comments?: Array<{ body?: string }> }
    for (const comment of parsed.comments ?? []) {
      for (const key of extractLogMarkers(comment.body ?? '')) markers.add(key)
    }
  } catch {
    // Tolerant: a forge read failure must never block a flush.
  }
  return markers
}

function renderChunk(runId: string, seqFrom: number, seqTo: number, postLines: readonly string[]): string {
  const marker = `<!-- aeg:log:${runId}:${seqFrom}-${seqTo} -->`
  return `${marker}\n\n\`\`\`ndjson\n${postLines.join('\n')}\n\`\`\`\n`
}

/**
 * Splits `lines` first at `run_id` boundaries — a maximal run of
 * CONSECUTIVE lines sharing one `run_id`, never a global group-by — then at
 * `maxChars` within each run. Grouping only consecutive occurrences is what
 * keeps every chunk's `seqFrom-seqTo` genuinely contiguous even when two
 * run_ids interleave in the file: two runs of the same `run_id` separated by
 * another run_id's lines become two separate chunks, never one range that
 * silently spans the gap.
 */
function planFlush(lines: readonly string[], maxChars: number): FlushChunk[] {
  const parsed = lines.map((l, i) => parseOutboxLine(l, i))
  const chunks: FlushChunk[] = []
  let i = 0
  while (i < parsed.length) {
    const runId = (parsed[i] as ParsedLine).runId
    let j = i
    while (j < parsed.length && (parsed[j] as ParsedLine).runId === runId) j++

    let groupLines: string[] = []
    let seqFrom = (parsed[i] as ParsedLine).seq
    let seqTo = seqFrom

    for (let k = i; k < j; k++) {
      const line = parsed[k] as ParsedLine
      if (groupLines.length === 0) {
        groupLines = [line.postLine]
        seqFrom = line.seq
        seqTo = line.seq
        if (renderChunk(runId, seqFrom, seqTo, groupLines).length > maxChars) throw new LineTooLargeError(line.seq)
        continue
      }
      const candidateLines = [...groupLines, line.postLine]
      const candidateBody = renderChunk(runId, seqFrom, line.seq, candidateLines)
      if (candidateBody.length <= maxChars) {
        groupLines = candidateLines
        seqTo = line.seq
      } else {
        chunks.push({ runId, seqFrom, seqTo, body: renderChunk(runId, seqFrom, seqTo, groupLines) })
        groupLines = [line.postLine]
        seqFrom = line.seq
        seqTo = line.seq
        if (renderChunk(runId, seqFrom, seqTo, groupLines).length > maxChars) throw new LineTooLargeError(line.seq)
      }
    }
    if (groupLines.length > 0)
      chunks.push({ runId, seqFrom, seqTo, body: renderChunk(runId, seqFrom, seqTo, groupLines) })
    i = j
  }
  return chunks
}

/** Array-form `execFileSync` against `gh`, throwing with the real stderr text (`pr-report.ts`'s `gh()`). */
function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    throw new Error(String(stderr ?? (err as Error).message).trim() || 'gh command failed')
  }
}

/** Codes a `LogFlushError` carries — one per distinct refusal `logFlushCommand` maps to its own check id and recovery prompt (`commands/log.ts`). */
export type LogFlushErrorCode =
  | 'log-flush-pr-closes-n'
  | 'log-flush-symlink'
  | 'log-flush-line-too-large'
  | 'log-flush-corrupt-line'
  | 'log-flush-audit-line-unconfirmed'
  | 'log-flush-gh-failed'

/**
 * The one thrown-error shape `flushOutbox` ever raises. Never `process.exit`
 * — a caller (the one-shot command, or an in-process driver) decides what a
 * given code means for its own control flow.
 */
export class LogFlushError extends Error {
  readonly code: LogFlushErrorCode
  /**
   * Set only for `'log-flush-gh-failed'`, when the 'refused' audit line
   * ALSO could not be confirmed landed — a non-fatal warning a caller should
   * surface alongside the refusal itself, worded exactly as
   * `commands/log.ts` used to emit it inline. `undefined` for every other
   * code, and for a confirmed 'refused' line.
   */
  readonly warning?: string
  constructor(code: LogFlushErrorCode, message: string, warning?: string) {
    super(message)
    this.code = code
    this.warning = warning
  }
}

function issueFromPr(prNumber: string): number {
  const body = JSON.parse(gh(['pr', 'view', prNumber, '--json', 'body'])) as { body: string }
  const { issue } = extractIssue(body.body)
  if (issue === null) {
    throw new LogFlushError(
      'log-flush-pr-closes-n',
      `PR #${prNumber}'s body carries no \`Closes #N\` line — cannot resolve which Issue's outbox to flush.`
    )
  }
  return issue
}

function postChunk(op: ForgeOp, targetId: string, body: string, index: number): string {
  const tmp = join(tmpdir(), `vinaya-log-flush-${process.pid}-${Date.now()}-${index}.md`)
  writeFileSync(tmp, body, { flag: 'wx' })
  try {
    const out =
      op === 'pr.comment'
        ? gh(['pr', 'comment', targetId, '--body-file', tmp])
        : gh(['issue', 'comment', targetId, '--body-file', tmp])
    const match = /#issuecomment-(\d+)/.exec(out)
    if (match) return match[1] as string
    // `gh`'s stdout didn't shape into a comment URL — the post itself
    // succeeded (no thrown error), but recording the raw, unparsed text as
    // if it were the id would misrepresent an honest "we don't know the id"
    // as a real one.
    process.stderr.write(`vinaya: log flush could not parse a comment id from gh's output: ${out}\n`)
    return `unparsed:${out.slice(0, 200)}`
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Exactly one of `issue`/`pr` — the same target shape `vinaya log flush --issue <n> | --pr <n>` accepts, resolved by the command's own argv parsing, never re-parsed here. */
export type LogFlushTarget = { issue: number } | { pr: number }

export type LogFlushOutcome =
  | { flushed: false }
  | {
      flushed: true
      op: ForgeOp
      target: { issue?: number; pr?: number }
      commentIds: string[]
      chunkCount: number
      /**
       * Non-null when the 'written' forge_write audit line could not be
       * confirmed landed — posting and truncation still completed; a
       * caller should surface this as a non-fatal warning, worded exactly
       * as returned.
       */
      warning: string | null
    }

/**
 * Options for `flushOutbox`. `skipRemotelyAccepted` (`task-log-v1` task 2,
 * Issue #562, O2) turns on the idempotent-retry read: before posting, read the
 * target's existing comments and acknowledge — without re-posting — any chunk
 * whose `<!-- aeg:log:… -->` marker is already on the forge (a prior attempt
 * that posted but died before truncating). It is OFF by default so the
 * in-process driver callers (`dev-review-loop.ts`, `dispatch.ts`) keep their
 * exact forge-read sequence — those drivers already read the task's comments
 * through their own `fetchLoopHistory`, and their tests are calibrated to that
 * exact call count; the retriable one-shot `vinaya log flush` command, the
 * surface the Boundary names ("flush retries can repeat remotely accepted
 * batches"), is the caller that turns it ON.
 */
export type FlushOptions = { skipRemotelyAccepted?: boolean }

/**
 * The flush's whole body (task 3, `#482`, O1) — posts `target`'s outbox as
 * one or more comments and truncates only what the forge confirmed, exactly
 * as `apps/cli/specs/log.md` § The flush describes. Never calls
 * `process.exit`: returns `{flushed: false}` for a missing or empty outbox,
 * returns the posted outcome on success, and throws `LogFlushError` for
 * every refusal — safe to call in-process from a long-running driver as
 * well as from the one-shot command (O2).
 */
export async function flushOutbox(target: LogFlushTarget, options: FlushOptions = {}): Promise<LogFlushOutcome> {
  const op: ForgeOp = 'pr' in target ? 'pr.comment' : 'issue.comment'
  const issueNumber = 'pr' in target ? issueFromPr(String(target.pr)) : target.issue
  const eventTarget = 'pr' in target ? { pr: target.pr } : { issue: issueNumber }
  const forgeTargetId = 'pr' in target ? String(target.pr) : String(issueNumber)

  const resolved = await resolveRepo()
  const repo = resolved && isSafeRepoSegment(resolved.owner) && isSafeRepoSegment(resolved.repo) ? resolved : null
  const outboxRoot = () => join(GLOBAL_VINAYA_HOME, 'outbox')
  const path = sinkOutboxPathFor({ outboxRoot }, repo, issueNumber)

  let lstat: ReturnType<typeof lstatSync> | undefined
  try {
    lstat = lstatSync(path)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }

  if (lstat === undefined) return { flushed: false }
  if (!lstat.isFile()) {
    throw new LogFlushError(
      'log-flush-symlink',
      `log flush: outbox target is not a regular file (symlink, FIFO, or similar) — refusing to read: ${path}`
    )
  }

  const buf = readFileSync(path)
  const startOffset = buf.byteLength
  const rawLines = buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.length > 0)

  if (rawLines.length === 0) return { flushed: false }

  let chunks: FlushChunk[]
  try {
    chunks = planFlush(rawLines, FORGE_COMMENT_MAX_CHARS)
  } catch (err) {
    if (err instanceof LineTooLargeError) throw new LogFlushError('log-flush-line-too-large', err.message)
    if (err instanceof CorruptOutboxLineError) throw new LogFlushError('log-flush-corrupt-line', err.message)
    throw err
  }

  // O3 orders the audit line strictly before any post. If we cannot confirm
  // it landed, we do not know that ordering held — refuse before posting
  // anything rather than proceed on an unconfirmed guarantee. Nothing has
  // been posted or truncated yet, so refusing here is safe and total.
  const validatedLanded = await logForFlush(issueNumber, path, {
    kind: 'forge_write',
    event: 'validated',
    op,
    target: eventTarget,
    payload: {}
  })
  if (!validatedLanded) {
    throw new LogFlushError(
      'log-flush-audit-line-unconfirmed',
      `log flush: could not confirm the 'validated' forge_write line landed in ${path} before posting.`
    )
  }

  // O2 idempotency: a prior attempt may have posted some chunks but died
  // before truncating them (a lost acknowledgement). Their markers are still
  // on the forge — read them once and acknowledge (truncate) an
  // already-posted chunk without posting a second copy. Only the one-shot
  // command opts in (see `FlushOptions`).
  const alreadyPosted = options.skipRemotelyAccepted ? existingLogMarkers(op, forgeTargetId) : new Set<string>()

  const commentIds: string[] = []
  let postedLineCount = 0
  let failure: { chunk: FlushChunk; message: string } | undefined

  for (const chunk of chunks) {
    const markerKey = `${chunk.runId}:${chunk.seqFrom}-${chunk.seqTo}`
    if (alreadyPosted.has(markerKey)) {
      // Remotely accepted on a prior attempt — acknowledge, never re-post.
      postedLineCount += chunk.seqTo - chunk.seqFrom + 1
      continue
    }
    try {
      const id = postChunk(op, forgeTargetId, chunk.body, postedLineCount)
      commentIds.push(id)
      postedLineCount += chunk.seqTo - chunk.seqFrom + 1
    } catch (err) {
      failure = { chunk, message: err instanceof Error ? err.message : String(err) }
      break
    }
  }

  // By this point posting is done (fully or partially) — truncation MUST
  // still run regardless of whether this second audit line is confirmed,
  // or an unconfirmed timeout here would silently re-post already-succeeded
  // comments on the next flush (worse than a missing audit line).
  const finalLanded = failure
    ? await logForFlush(issueNumber, path, {
        kind: 'forge_write',
        event: 'refused',
        op,
        target: eventTarget,
        payload: {},
        reason: `flush of run ${failure.chunk.runId} seq ${failure.chunk.seqFrom}-${failure.chunk.seqTo} failed: ${failure.message}`
      })
    : await logForFlush(issueNumber, path, {
        kind: 'forge_write',
        event: 'written',
        op,
        target: eventTarget,
        payload: {},
        comment_ids: commentIds
      })

  // Truncate to: the original lines never confirmed posted, plus whatever
  // was appended to the live file after `startOffset` — the `validated`/
  // `refused`/`written` lines just logged, and any concurrent process's
  // lines. Never the bytes read before `startOffset`: those are exactly the
  // lines this run is answering for.
  const unposted = rawLines
    .slice(postedLineCount)
    .map((l) => `${l}\n`)
    .join('')
  const liveNow = readFileSync(path)
  const tail = liveNow.subarray(Math.min(startOffset, liveNow.byteLength))
  writeFileSync(path, Buffer.concat([Buffer.from(unposted, 'utf8'), tail]))

  const warningFor = (eventLabel: 'written' | 'refused'): string =>
    `log flush: could not confirm the '${eventLabel}' forge_write line landed in ${path} — posting and truncation still completed.`

  if (failure) {
    throw new LogFlushError(
      'log-flush-gh-failed',
      `log flush: gh failed posting run ${failure.chunk.runId} seq ${failure.chunk.seqFrom}-${failure.chunk.seqTo}: ${failure.message}`,
      finalLanded ? undefined : warningFor('refused')
    )
  }

  return {
    flushed: true,
    op,
    target: eventTarget,
    commentIds,
    chunkCount: chunks.length,
    warning: finalLanded ? null : warningFor('written')
  }
}
