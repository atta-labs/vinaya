/**
 * `dev-review-loop`'s round-assessment-glue concern (task 8,
 * `#506`, O8) — the generic wait/detect/route helpers a round uses
 * around `@attalabs/aeg-core`'s `assessRound` (the ENTIRE policy; this
 * module never re-implements a stop condition or a round-outcome decision):
 * confidence-reply parsing, diff-stat parsing, dispatch/resume escalation,
 * polling, durable-log-line waiting, and completion-event routing. Moved
 * out of `apps/cli/src/lib/dev-review-loop.ts` verbatim; `dev-review-loop.ts`
 * stays the composition root, re-exporting every name below under the same
 * path it always had.
 */

import { readFileSync } from 'node:fs'
import {
  defaultControlStoreDeps,
  readLoopState,
  writeLoopState,
  type Confidence,
  type Decision,
  type DevReviewLoopEventInput,
  type LoopBudgets,
  type LoopState,
  type LoopStateRecord,
  type ParsedRecord,
  type RoundHeadIdentity,
  type RoundStats
} from '@attalabs/aeg-core'
import type { AgentVendor, DispatchHandle } from '../dispatch.js'
import { controlStoreRoot } from '../effects.js'

// --- confidence -------------------------------------------------------------

/**
 * Fixed text, appended to the developer's resume prompt on every round ≥ 2
 * (Part 3). The file path is a fixed, well-known relative convention — the
 * worktree root every Developer already works in
 * (`aeg-root/roles/developer.md`'s own `.worktrees/task/<tranche>/<n>/`) —
 * so this constant needs no per-round interpolation to stay fixed.
 */
export const CONFIDENCE_PROMPT_LINE =
  "Before ending this turn, write your confidence in this round's changes to a file named `.vinaya-confidence` at the root of your worktree, containing exactly one line: `CONFIDENCE: <0-100> — <one-sentence reason>` (a whole number from 0 to 100, an em dash, then your reason in one sentence) — for example: `echo 'CONFIDENCE: 90 — fixed the reported issue' > .vinaya-confidence`. This is read by the review loop before it decides the next step — do not skip it."

const CONFIDENCE_LINE = /^CONFIDENCE:\s*(\d{1,3})\s*(?:—|-)\s*(.+)$/m

/** `'absent'` for a missing or malformed reply — never guessed into a number. */
export function parseConfidenceReply(replyText: string): Confidence {
  const m = CONFIDENCE_LINE.exec(replyText)
  if (!m) return 'absent'
  const value = Number(m[1])
  if (!Number.isFinite(value) || value < 0 || value > 100) return 'absent'
  const reason = (m[2] ?? '').trim()
  return reason ? { value, reason } : { value }
}

export const CONFIDENCE_FILE_NAME = '.vinaya-confidence'

// --- round response -----------------------------------------------------

/**
 * The Developer's own side channel for citing which finding ids it addressed
 * this round — same worktree-root convention as `CONFIDENCE_FILE_NAME`
 * (`aeg-root/roles/developer.md`'s `.worktrees/task/<tranche>/<n>/`), read
 * and cleared by the driver instead of the Developer posting a PR comment.
 * The driver now ends the Developer's turn at the push — it
 * composes and posts the round marker comment itself, from this file's
 * content (`renderDeveloperRoundComment`), so a Developer session that
 * crashes, skips, or forgets to write this file never blocks the round: it
 * is read best-effort, and an absent or empty file yields no citation, never
 * a resume or a pause. "No round is judged no_progress because a comment was
 * not posted" (this task's Objective O2) — the round's own no-progress
 * derivation (`assessRound`'s id-comparison across rounds, `@attalabs/aeg-core`)
 * never reads this file at all; it exists purely so the driver's own posted
 * comment can carry the same finding-id citation a Developer used to type by
 * hand.
 */
export const DEVELOPER_ROUND_RESPONSE_FILE_NAME = '.vinaya-round-response'

/**
 * Fixed text appended to the developer's resume prompt whenever this round
 * carries findings to address — the response-file counterpart to
 * `CONFIDENCE_PROMPT_LINE`. Best-effort by design (see
 * `DEVELOPER_ROUND_RESPONSE_FILE_NAME`'s own doc comment): omitted, the round
 * comment the driver posts simply carries no `FINDING_IDS:` citation.
 */
export const ROUND_RESPONSE_PROMPT_LINE = `Before ending this turn, write a \`FINDING_IDS:\` line to a file named \`${DEVELOPER_ROUND_RESPONSE_FILE_NAME}\` at the root of your worktree, citing the ids (comma-separated, e.g. \`F1,F2\`) of the findings above you addressed this round — the driver reads this to compose the round's own comment; you do not post one yourself.`

const ROUND_RESPONSE_FINDING_IDS_LINE = /^FINDING_IDS:\s*(.*)$/im

/** The comma-separated ids off a `FINDING_IDS:` line in the Developer's round-response file content — `[]` for missing/malformed/empty content, never a throw: see `DEVELOPER_ROUND_RESPONSE_FILE_NAME`'s own doc comment on why this stays best-effort. */
export function parseRoundResponseFindingIds(raw: string | null): string[] {
  if (!raw) return []
  const m = ROUND_RESPONSE_FINDING_IDS_LINE.exec(raw)
  if (!m) return []
  return (m[1] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

/** The round marker itself, `<!-- aeg:developer:round-<n> -->` — `@attalabs/aeg-core`'s `parseDeveloperRoundMarker` matches it anywhere in a comment body; posted first by `postMarkedComment` (`dev-review-loop.ts`'s `postDeveloperRoundComment`), the same convention every other driver-posted marked comment in this file already uses. */
export function developerRoundMarker(roundNum: number): string {
  return `<!-- aeg:developer:round-${roundNum} -->`
}

/**
 * The BODY half of the round marker comment the driver now posts in the
 * Developer's place — `postMarkedComment` prepends
 * `developerRoundMarker(roundNum)` ahead of this, so the full posted comment
 * reads marker, then `Head: <sha>`, then (only when there is something to
 * cite) a `FINDING_IDS:` line. An empty `findingIds` list — round 1's first
 * review, or a Developer that wrote no response file — omits the
 * `FINDING_IDS:` line entirely, the same "nothing to cite" convention the
 * reviewer's own `FINDING_IDS:` grammar uses for an empty findings list.
 */
export function renderDeveloperRoundComment(head: string, findingIds: readonly string[]): string {
  const lines = [`Head: ${head}`]
  if (findingIds.length > 0) lines.push(`FINDING_IDS: ${findingIds.join(',')}`)
  return lines.join('\n')
}

export function parseShortstat(stat: string): { filesChanged: number; insertions: number; deletions: number } {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat)
  if (!m) return { filesChanged: 0, insertions: 0, deletions: 0 }
  return { filesChanged: Number(m[1] ?? 0), insertions: Number(m[2] ?? 0), deletions: Number(m[3] ?? 0) }
}

/** Thrown when a round's resume attempt fails for a vendor whose previous round succeeded — Section 10's own stop-and-escalate, never a fallback to a fresh session. */
export class DevReviewLoopResumeError extends Error {}

export async function assertDispatchOrEscalate(
  handle: DispatchHandle,
  vendor: AgentVendor,
  isResume: boolean,
  previousRoundSucceededForVendor: boolean
): Promise<void> {
  if (!handle.failureReason) return
  if (isResume && previousRoundSucceededForVendor) {
    throw new DevReviewLoopResumeError(
      `devReviewLoop: ${vendor}'s resume failed this round (${handle.failureReason}) after succeeding last round — ` +
        `stop-and-escalate severity:product, vendor: ${vendor}. Never falling back to a fresh developer session (Principal ruling, 2026-09-04).`
    )
  }
  throw new Error(`devReviewLoop: dispatching ${vendor} failed (${handle.failureReason}).`)
}

/**
 * `timeoutMessage` may be a plain string or a thunk — the thunk form (O3)
 * is evaluated ONLY on the timeout path, never on
 * every attempt: a message that itself reads the forge (branch/local/remote
 * head, PR existence) must not cost an extra round of shell calls on the
 * common, poll-succeeds-immediately path.
 */
export async function pollUntil<T>(
  fn: () => T | null,
  maxAttempts: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
  timeoutMessage: string | (() => string)
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = fn()
    if (result !== null) return result
    await sleep(intervalMs)
  }
  throw new Error(typeof timeoutMessage === 'function' ? timeoutMessage() : timeoutMessage)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

export function sizeOfSafe(path: string): number {
  try {
    return readFileSync(path).byteLength
  } catch {
    return 0
  }
}

/**
 * True when a line APPENDED SINCE `priorSize` (never the whole file — a
 * prior round can log the identical shape, e.g. another `round_started`)
 * carries `meta.run_id === runId` and, stripped of `meta`/`subject`, deep-
 * equals `event`. Mirrors `dispatch.ts`'s private `hasOwnDispatchLine`,
 * matched on the event's own shape instead of an `effect_id` — `DevReviewLoopEvent`
 * carries none.
 */
function hasOwnLoopLine(path: string, priorSize: number, runId: string, event: DevReviewLoopEventInput): boolean {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return false
  }
  if (buf.byteLength <= priorSize) return false
  for (const raw of buf.subarray(priorSize).toString('utf8').split('\n')) {
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as { meta?: { run_id?: unknown }; [k: string]: unknown }
      if (obj.meta?.run_id !== runId) continue
      const { meta: _meta, subject: _subject, ...rest } = obj
      if (deepEqual(rest, event)) return true
    } catch {
      // not a JSON line — never trusted blindly
    }
  }
  return false
}

/**
 * `log()` is fire-and-forget (`log-sink.ts`'s own `.then()` chain, no
 * returned promise) — a caller that fires the next `log()` call right after
 * can race a still-pending write, exactly `dispatch.ts`'s own
 * `waitForDispatchLine` doc comment describes for its equivalent hazard, and
 * this driver logs SEVERAL events per round, back to back. Not merely
 * theoretical: observed live authoring this task, two `log()` calls in the
 * same synchronous loop landed OUT OF ORDER in the outbox — `resolveRepo()`
 * only caches a DETERMINISTIC outcome (`resolve-repo.ts`'s own doc comment);
 * on an unresolvable repo (this task's own test fixtures; no git remote) it
 * caches NOTHING, so every `log()` call races an independent, uncached async
 * resolution. Waiting for a raw line COUNT to reach N after firing N calls
 * does not fix this — it can be satisfied by N lines in the WRONG order.
 * `logEvents` (below) awaits THIS, per event, before firing the next
 * `log()` call, so no two of this driver's own writes are ever in flight at
 * once — order follows call order because nothing races.
 */
export async function waitForOwnLoopLine(
  path: string,
  priorSize: number,
  runId: string,
  event: DevReviewLoopEventInput,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasOwnLoopLine(path, priorSize, runId, event)) return
    await sleep(5)
  }
  // Best-effort durability wait, not a correctness gate — `log()` itself
  // never throws, and a timeout here is already `log()`'s own silently-
  // warned failure mode (an unwritable outbox, an unresolvable repo, or a
  // schema violation `log()` refused and warned about instead of writing).
}

export function routeCompletionEvents(
  events: readonly DevReviewLoopEventInput[],
  decisionType: Decision['type']
): { toLogNow: DevReviewLoopEventInput[]; toDeferUntilPublish: DevReviewLoopEventInput[] } {
  if (decisionType !== 'publish') return { toLogNow: [...events], toDeferUntilPublish: [] }
  return {
    toLogNow: events.filter((e) => e.event !== 'journal_finalized'),
    toDeferUntilPublish: events.filter((e) => e.event === 'journal_finalized')
  }
}

/**
 * Task `#488`, O2: the bound on consecutive
 * gate-red developer turns that produce no push on one head — small and
 * strict, since the failure mode this bounds (`#479`: five re-dispatches in
 * two minutes on one head) is a developer making no progress at all, not
 * one that needs several genuine attempts. Driver-owned rather than a
 * `packages/aeg-core` constant: this task's own Surface (Issue #488 §4)
 * declares `packages` out of scope.
 */
export const MAX_GATE_STALLED_TURNS = 2

/**
 * `control-store-v1` task 4, O2: the bound on this task's own cumulative
 * `'infrastructure'`/`'stale_driver'` pause count — never reset by a
 * restart, unlike `MAX_GATE_STALLED_TURNS` (a per-episode, in-memory
 * counter already bounded within one process's own round loop).  Small: the
 * failure mode this bounds is a task that keeps hitting the driver's own
 * recoverable-hiccup class of pause and getting `--resume`d past it forever,
 * never a genuine review round that needs many honest attempts.
 */
export const MAX_INFRASTRUCTURE_RETRIES = 5

// --- authoritative loop-state recovery (control-store-v1 task 4, O1) -------

/**
 * The snapshot `persistLoopState` writes and `loadLoopState`/
 * `recoverLoopState` (`pause-resume.ts`) read back — phase, round, budgets,
 * held-result and delivered-findings identity, the exact fields
 * `LoopStateRecordSchema` (`@attalabs/aeg-core`) carries minus its own
 * `version`/`kind`/`task`/`recordedAt` (supplied by the write wrapper).
 */
export type LoopStateSnapshot = {
  round: number
  /** Mirrors `Decision['type']` — a plain string so this module needn't import `packages/aeg-core`'s `Decision` type just to re-narrow it. */
  phase: string
  pauseReason?: string
  budgets: LoopBudgets
  heldResult: RoundHeadIdentity | null
  deliveredFindings: RoundHeadIdentity | null
}

/**
 * Persists `snapshot` as this task's authoritative control-store loop-state
 * record. Best-effort, like `persistManifestRecord` (`reviewer-dispatch.ts`):
 * a write failure never fails a round the way the loop's own paperwork must
 * never cost one (`loop.md`, O1) — the driver's own in-memory `round`/
 * budget variables are what actually govern THIS process's own run; this
 * write only makes that state recoverable by a LATER attach/resume.
 */
export function persistLoopState(task: number, snapshot: LoopStateSnapshot, now: () => Date = () => new Date()): void {
  try {
    const deps = defaultControlStoreDeps(controlStoreRoot)
    writeLoopState(deps, task, {
      round: snapshot.round,
      phase: snapshot.phase,
      pauseReason: snapshot.pauseReason ?? null,
      budgets: snapshot.budgets,
      heldResult: snapshot.heldResult,
      deliveredFindings: snapshot.deliveredFindings,
      recordedAt: now().toISOString()
    })
  } catch {
    // Never thrown past this call — see this function's own doc comment.
  }
}

/**
 * Reads this task's control-store loop-state record — `'absent'` for a task
 * that never persisted one (a fresh task, or one that predates this
 * mechanism); `'corrupt'` surfaced honestly, never silently read as absent
 * (O3: a caller must be able to tell "nothing to recover" apart from
 * "something recorded but untrustworthy" — the latter is never license to
 * reset budgets or authorize progression).
 */
export function loadLoopState(task: number): ParsedRecord<LoopStateRecord> {
  const deps = defaultControlStoreDeps(controlStoreRoot)
  return readLoopState(deps, task)
}

/**
 * `stop_condition_met`/`paused`/`round_ended`/`journal_finalized` for a
 * pause the DRIVER decides itself — O2's gate-stalled bound and O5's
 * reviewer-infrastructure failure, neither of which corresponds to an
 * `Observations` kind `assessRound` accepts (adding one would edit
 * `packages/aeg-core`, out of this task's declared Surface, Issue #488 §4;
 * `Decision`/`PauseReason` themselves are unchanged). Reuses
 * `stop_condition_met`'s existing, otherwise-unused `'principal_stop'`
 * condition and `paused`'s existing generic `'principal_item'` reason —
 * the SAME schema enum members every policy-decided bounded pause already
 * reuses for confidence/reappearance/no_progress/max_rounds — never a new
 * schema value, so these events validate and land in the outbox exactly
 * like a policy-decided pause's do (regression, PR #489 round 2, MAJOR:
 * this pause used to skip the log entirely). `state` is read only for its
 * running totals; it is never written back, since the loop returns
 * immediately after this — a resume starts a fresh `LoopState` regardless
 * (`initialLoopState`, called fresh in the `--resume` path above).
 */
export function driverDecidedPauseEvents(
  loopId: string,
  state: LoopState,
  round: number,
  stats: RoundStats
): DevReviewLoopEventInput[] {
  const envelope = { kind: 'dev_review_loop' as const, payload: {} }
  return [
    { ...envelope, loop_id: loopId, event: 'stop_condition_met', round, condition: 'principal_stop' },
    { ...envelope, loop_id: loopId, event: 'paused', round, reason: 'principal_item' },
    {
      ...envelope,
      loop_id: loopId,
      event: 'round_ended',
      round,
      base_head: stats.baseHead,
      head: stats.head,
      files_changed: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
      wall_ms: stats.wallMs,
      outcome: 'changes_requested'
    },
    {
      ...envelope,
      loop_id: loopId,
      event: 'journal_finalized',
      rounds: state.rounds.length + 1,
      total_wall_ms: state.totalWallMs + stats.wallMs,
      time_to_green_ms: null,
      files_changed_total: state.totalFilesChanged + stats.filesChanged,
      final_head: stats.head,
      result: 'stopped'
    }
  ]
}

/**
 * `paused`/`journal_finalized` for a genuinely UNCAUGHT error — the
 * `finally`-adjacent catch wrapping the whole round loop in
 * `dev-review-loop.ts` (task 21, `#541`, O10, round 2 review BLOCKER).
 * Deliberately NOT `driverDecidedPauseEvents`: that helper also logs its
 * own `round_ended` with a hardcoded `outcome: 'changes_requested'` and
 * bumps `journal_finalized.rounds` by one, both correct only when the
 * CURRENT round never reached its own real `round_ended` at all. An
 * uncaught error can just as easily strike AFTER a genuine `round_ended`
 * already logged a real outcome (a crash between `round_ended` and the
 * (deferred) `journal_finalized` — precisely `publishRound` throwing after
 * a green round, the shape O9's `journalFinalized` signal exists to
 * detect) — reusing `driverDecidedPauseEvents` there would silently
 * overwrite that real, already-true outcome with a fabricated one and
 * double-count the round. This helper never touches `round_ended` at all:
 * it closes the journal with whatever `state.rounds` ALREADY holds,
 * honest about a run that ended with no clean decision either way.
 */
export function driverCrashEvents(
  loopId: string,
  state: LoopState,
  round: number,
  head: string
): DevReviewLoopEventInput[] {
  const envelope = { kind: 'dev_review_loop' as const, payload: {} }
  return [
    { ...envelope, loop_id: loopId, event: 'paused', round, reason: 'principal_item' },
    {
      ...envelope,
      loop_id: loopId,
      event: 'journal_finalized',
      rounds: state.rounds.length,
      total_wall_ms: state.totalWallMs,
      time_to_green_ms: null,
      files_changed_total: state.totalFilesChanged,
      final_head: head,
      result: 'stopped'
    }
  ]
}
