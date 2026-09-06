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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { extractIssue, type ForgeOp } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError, emitCheckError } from '../checks/contract.js'
import { log, outboxPathFor as sinkOutboxPathFor, type LogEventInput } from '../lib/log-sink.js'
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

/**
 * `log()` is fire-and-forget (`deps.resolveRepo().then(...)`, no returned
 * promise, by design — task 1's shipped, frozen interface) and its internal
 * `resolveRepo()` call is a real (if usually cache-hit) async boundary, not
 * a fixed number of microtask ticks — a `setImmediate`/`Promise` drain proved
 * unreliable across hosts (observed live: passed under `node` on the built
 * CLI, failed under `bun` running the TS source directly). Waiting for the
 * outbox file to actually grow past its pre-call size is the only signal
 * that does not guess at scheduling internals.
 */
async function waitForOutboxGrowth(path: string, priorSize: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sizeOf(path) > priorSize) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`log flush: log()'s own line never landed in ${path} within ${timeoutMs}ms`)
}

/**
 * `log()` fills `subject.issue` from `process.env.VINAYA_TASK`
 * (`log/envelope.ts`'s `issueFromTask`) — never from an argument. For this
 * call's line to land in the SAME outbox this command is about to
 * truncate, `VINAYA_TASK` is set to the flushed Issue for the duration of
 * the call, restored after; `waitForOutboxGrowth` blocks until that
 * fire-and-forget write has actually landed on disk before this command
 * reads the file back or exits (a bare `process.exit()` right after `log()`
 * would otherwise abandon the write mid-flight).
 */
async function logForFlush(issueNumber: number, path: string, e: LogEventInput): Promise<void> {
  const prevTask = process.env.VINAYA_TASK
  process.env.VINAYA_TASK = String(issueNumber)
  const priorSize = sizeOf(path)
  try {
    log(e)
    await waitForOutboxGrowth(path, priorSize)
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

type ParsedLine = { raw: string; runId: string; seq: number }

function parseOutboxLine(raw: string, index: number): ParsedLine {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new Error(`log flush: outbox line ${index} is not valid JSON`)
  }
  const meta = (obj as { meta?: unknown }).meta as { run_id?: unknown; seq?: unknown } | undefined
  if (!meta || typeof meta.run_id !== 'string' || typeof meta.seq !== 'number') {
    throw new Error(`log flush: outbox line ${index} is missing meta.run_id / meta.seq`)
  }
  return { raw, runId: meta.run_id, seq: meta.seq }
}

function renderChunk(runId: string, seqFrom: number, seqTo: number, rawLines: readonly string[]): string {
  const marker = `<!-- aeg:log:${runId}:${seqFrom}-${seqTo} -->`
  return `${marker}\n\n\`\`\`ndjson\n${rawLines.join('\n')}\n\`\`\`\n`
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
        groupLines = [line.raw]
        seqFrom = line.seq
        seqTo = line.seq
        if (renderChunk(runId, seqFrom, seqTo, groupLines).length > maxChars) throw new LineTooLargeError(line.seq)
        continue
      }
      const candidateLines = [...groupLines, line.raw]
      const candidateBody = renderChunk(runId, seqFrom, line.seq, candidateLines)
      if (candidateBody.length <= maxChars) {
        groupLines = candidateLines
        seqTo = line.seq
      } else {
        chunks.push({ runId, seqFrom, seqTo, body: renderChunk(runId, seqFrom, seqTo, groupLines) })
        groupLines = [line.raw]
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
    return match ? (match[1] as string) : out
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
    throw err
  }

  await logForFlush(issueNumber, path, { kind: 'forge_write', event: 'validated', op, target, payload: {} })

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

  if (failure) {
    await logForFlush(issueNumber, path, {
      kind: 'forge_write',
      event: 'refused',
      op,
      target,
      payload: {},
      reason: `flush of run ${failure.chunk.runId} seq ${failure.chunk.seqFrom}-${failure.chunk.seqTo} failed: ${failure.message}`
    })
  } else {
    await logForFlush(issueNumber, path, {
      kind: 'forge_write',
      event: 'written',
      op,
      target,
      payload: {},
      comment_ids: commentIds
    })
  }

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
