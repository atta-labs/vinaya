/**
 * `vinaya log flush` (task 2, Issue #405, `apps/cli/specs/log.md` § The
 * flush). Posts a target's outbox — written by `log()`
 * (`apps/cli/src/lib/log-sink.ts`) — as one or more marked comments on an
 * Issue or a PR, then truncates only the lines the forge confirmed.
 *
 * I/O only. The chunking itself (`planFlush`) is pure and unit-tested on its
 * own; this file wires it to `gh`, the outbox file, and `log()`.
 */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { extractIssue, LogEventSchema, redact, type ForgeOp } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError, emitCheckError } from '../checks/contract.js'
import { currentRunId, log, outboxPathFor as sinkOutboxPathFor, type LogEventInput } from '../lib/log-sink.js'
import { GLOBAL_VINAYA_HOME } from '../lib/config.js'
import { printJson } from '../lib/envelope.js'

/** A comment is closed before adding the next line would push it past this (`apps/cli/specs/log.md`). */
export const FORGE_COMMENT_MAX_CHARS = 65536

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

export type ForgeWriteSignature = {
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
 * call's line to land in the SAME outbox this command is about to
 * truncate, `VINAYA_TASK` is set to the flushed Issue for the duration of
 * the call, restored after. Returns whether the write was confirmed landed
 * (`waitForOwnLine`) rather than throwing — a timeout is not necessarily
 * fatal (see call sites): a bare `process.exit()` right after `log()` would
 * abandon the write mid-flight, but the caller decides what "not confirmed"
 * means for its own position in the flush.
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

function makeCheckError(check: string, message: string, agentRecoveryPrompt: string): CheckError {
  return { schema: CHECK_SCHEMA_VERSION, check, severity: 'error', message, agent_recovery_prompt: agentRecoveryPrompt }
}

/** Exit 2 (not `forge-write.ts`'s `refuse()`, which exits 1) — this command's own Test Plan pins the code. */
function refuse2(error: CheckError): never {
  emitCheckError(error)
  process.exit(2)
}

// Mirrors `log-sink.ts`'s own `SAFE_PATH_SEGMENT`/`isSafeRepoSegment` — not
// exported from there (that file's diff for this task stays to the one
// `outboxPathFor` extraction), so the same narrow guard is repeated here
// rather than widening that module's export surface for a one-line check.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
function isSafeRepoSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment) && !segment.includes('..')
}

/**
 * Pure composition over the Part 3 helper: takes an already-resolved repo
 * (never a `resolveRepo()` call of its own) so it stays a plain function of
 * its inputs, easy to unit-test without stubbing the network.
 */
export function outboxPathFor(
  deps: { outboxRoot: () => string; repo: { owner: string; repo: string } | null },
  target: { issue: number | null }
): string {
  return sinkOutboxPathFor({ outboxRoot: deps.outboxRoot }, deps.repo, target.issue)
}

export type FlushChunk = { runId: string; seqFrom: number; seqTo: number; body: string }

/** Thrown by `planFlush` when a single outbox line cannot fit in one comment even alone — never split across two. */
export class LineTooLargeError extends Error {
  readonly seq: number
  constructor(seq: number) {
    super(
      `log flush: outbox line at seq ${seq} is larger than FORGE_COMMENT_MAX_CHARS on its own — refusing to split a single line across two comments`
    )
    this.seq = seq
  }
}

/** Thrown by `parseOutboxLine` when a line fails full `LogEventSchema` re-validation — never posted, never trusted on faith. */
export class CorruptOutboxLineError extends Error {
  readonly index: number
  constructor(index: number, reason: string) {
    super(`log flush: outbox line ${index} failed schema re-validation — ${reason}`)
    this.index = index
  }
}

/** `runId`/`seq` for chunk planning; `postLine` is the re-redacted, re-serialized text actually posted — never the raw file bytes verbatim. */
type ParsedLine = { postLine: string; runId: string; seq: number }

/**
 * Re-validates a stored outbox line against the FULL `LogEventSchema` — not
 * merely presence of `meta.run_id`/`meta.seq` — and re-applies `redact()`
 * before this text is ever posted publicly (security review, PR #439). The
 * on-disk file is trusted for its own append-time write (`log()` already
 * validated and redacted once), but a flush is the second check-moment
 * before that content goes public, and a manually-edited line, a corrupted
 * one, or a future gap in `redact.ts`'s pattern coverage must not slip an
 * unfiltered line straight through. A line failing either check refuses the
 * whole flush (`CorruptOutboxLineError`) rather than silently skipping or
 * posting it — the same "refuse loudly, never mangle" posture as
 * `LineTooLargeError`.
 */
function parseOutboxLine(raw: string, index: number): ParsedLine {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new CorruptOutboxLineError(index, 'not valid JSON')
  }
  const result = LogEventSchema.safeParse(obj)
  if (!result.success) {
    throw new CorruptOutboxLineError(index, result.error.issues[0]?.message ?? 'schema violation')
  }
  const redacted = redact(result.data, homedir()) as { meta: { run_id: string; seq: number } }
  return { postLine: JSON.stringify(redacted), runId: redacted.meta.run_id, seq: redacted.meta.seq }
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
export function planFlush(lines: readonly string[], maxChars: number): FlushChunk[] {
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

function issueFromPr(prNumber: string): number {
  const body = JSON.parse(gh(['pr', 'view', prNumber, '--json', 'body'])) as { body: string }
  const { issue } = extractIssue(body.body)
  if (issue === null) {
    refuse2(
      makeCheckError(
        'log-flush-pr-closes-n',
        `PR #${prNumber}'s body carries no \`Closes #N\` line — cannot resolve which Issue's outbox to flush.`,
        'Add a `Closes #<N>` line to the PR body (the same anchor every gate reads), then re-run `vinaya log flush --pr <n>`.'
      )
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

type ParsedArgs = { issue: number | undefined; pr: number | undefined; json: boolean }

function parseArgs(args: string[]): ParsedArgs {
  let issueRaw: string | undefined
  let prRaw: string | undefined
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--issue') issueRaw = args[++i]
    else if (a === '--pr') prRaw = args[++i]
    else if (a === '--json') json = true
  }
  return {
    issue: issueRaw === undefined ? undefined : Number(issueRaw),
    pr: prRaw === undefined ? undefined : Number(prRaw),
    json
  }
}

export async function logFlushCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)
  if ((parsed.issue !== undefined) === (parsed.pr !== undefined)) {
    refuse2(
      makeCheckError(
        'log-flush-args',
        'vinaya log flush requires exactly one of --issue or --pr.',
        'Re-run with exactly one of `--issue <n>` or `--pr <n>`.'
      )
    )
  }

  const op: ForgeOp = parsed.pr !== undefined ? 'pr.comment' : 'issue.comment'
  const issueNumber = parsed.pr !== undefined ? issueFromPr(String(parsed.pr)) : (parsed.issue as number)
  const target = parsed.pr !== undefined ? { pr: parsed.pr } : { issue: issueNumber }
  const forgeTargetId = parsed.pr !== undefined ? String(parsed.pr) : String(issueNumber)

  const resolved = await resolveRepo()
  const repo = resolved && isSafeRepoSegment(resolved.owner) && isSafeRepoSegment(resolved.repo) ? resolved : null
  const outboxRoot = () => join(GLOBAL_VINAYA_HOME, 'outbox')
  const path = outboxPathFor({ outboxRoot, repo }, { issue: issueNumber })

  let lstat: ReturnType<typeof lstatSync> | undefined
  try {
    lstat = lstatSync(path)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }

  if (lstat === undefined) {
    process.stdout.write('log flush: nothing to flush\n')
    process.exit(0)
  }
  if (!lstat.isFile()) {
    refuse2(
      makeCheckError(
        'log-flush-symlink',
        `log flush: outbox target is not a regular file (symlink, FIFO, or similar) — refusing to read: ${path}`,
        'Remove or replace the outbox target with a regular file, then re-run `vinaya log flush`.'
      )
    )
  }

  const buf = readFileSync(path)
  const startOffset = buf.byteLength
  const rawLines = buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.length > 0)

  if (rawLines.length === 0) {
    process.stdout.write('log flush: nothing to flush\n')
    process.exit(0)
  }

  let chunks: FlushChunk[]
  try {
    chunks = planFlush(rawLines, FORGE_COMMENT_MAX_CHARS)
  } catch (err) {
    if (err instanceof LineTooLargeError) {
      refuse2(
        makeCheckError(
          'log-flush-line-too-large',
          err.message,
          'Split the offending event into smaller payload fields upstream — a single outbox line is never split across two comments.'
        )
      )
    }
    if (err instanceof CorruptOutboxLineError) {
      refuse2(
        makeCheckError(
          'log-flush-corrupt-line',
          err.message,
          'Inspect the named line by hand (a manual edit, disk corruption, or a redact.ts gap) — nothing was posted or truncated.'
        )
      )
    }
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
    target,
    payload: {}
  })
  if (!validatedLanded) {
    refuse2(
      makeCheckError(
        'log-flush-audit-line-unconfirmed',
        `log flush: could not confirm the 'validated' forge_write line landed in ${path} before posting.`,
        'Re-run `vinaya log flush` — nothing was posted or truncated.'
      )
    )
  }

  const commentIds: string[] = []
  let postedLineCount = 0
  let failure: { chunk: FlushChunk; message: string } | undefined

  for (const chunk of chunks) {
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
        target,
        payload: {},
        reason: `flush of run ${failure.chunk.runId} seq ${failure.chunk.seqFrom}-${failure.chunk.seqTo} failed: ${failure.message}`
      })
    : await logForFlush(issueNumber, path, {
        kind: 'forge_write',
        event: 'written',
        op,
        target,
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

  if (!finalLanded) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: 'log-flush-audit-line-unconfirmed',
      severity: 'warning',
      message: `log flush: could not confirm the '${failure ? 'refused' : 'written'}' forge_write line landed in ${path} — posting and truncation still completed.`,
      agent_recovery_prompt:
        'No action required for the posted comments; re-run `vinaya log flush` if the audit trail must be complete.'
    })
  }

  if (failure) {
    refuse2(
      makeCheckError(
        'log-flush-gh-failed',
        `log flush: gh failed posting run ${failure.chunk.runId} seq ${failure.chunk.seqFrom}-${failure.chunk.seqTo}: ${failure.message}`,
        'Fix the reported gh error (auth, rate limit, or network), then re-run `vinaya log flush` — unposted lines were preserved.'
      )
    )
  }

  if (parsed.json) {
    printJson({ posted: chunks.length, comment_ids: commentIds, target })
  } else {
    process.stdout.write(`log flush: posted ${chunks.length} comment(s), ${commentIds.length} confirmed\n`)
  }
}
