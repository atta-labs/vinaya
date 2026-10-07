/**
 * `dev-review-loop`'s round-assessment-glue concern — the generic wait/detect/route helpers a round uses
 * around `@attalabs/aeg-core`'s `assessRound` (the ENTIRE policy; this
 * module never re-implements a stop condition or a round-outcome decision):
 * the round marker comment, diff-stat parsing, dispatch/resume escalation,
 * polling, durable-log-line waiting, and completion-event routing. Moved
 * out of `apps/cli/src/lib/dev-review-loop.ts` verbatim; `dev-review-loop.ts`
 * stays the composition root, re-exporting every name below under the same
 * path it always had.
 */

import { readFileSync } from 'node:fs'
import { CODE_TOKEN_PATTERN } from '@attalabs/aeg-core/log'
import {
  defaultControlStoreDeps,
  readLoopState,
  writeLoopState,
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
import { isControlCharacter } from './turn-result.js'

// --- round marker comment ---------------------------------------------------

/** The round marker itself, `<!-- aeg:developer:round-<n> -->` — `@attalabs/aeg-core`'s `parseDeveloperRoundMarker` matches it anywhere in a comment body; posted first by `postMarkedComment` (`dev-review-loop.ts`'s `postDeveloperRoundComment`), the same convention every other driver-posted marked comment in this file already uses. */
export function developerRoundMarker(roundNum: number): string {
  return `<!-- aeg:developer:round-${roundNum} -->`
}

/**
 * The BODY half of the round marker comment the driver posts in the
 * Developer's place — `postMarkedComment` prepends
 * `developerRoundMarker(roundNum)` ahead of this, so the full posted comment
 * reads marker, then `Head: <sha>`, then (only when there is something to
 * cite) a `FINDING_IDS:` line carrying the round's accepted turn results'
 * `addressedFindingIds`, then (only when the Developer reported any) its
 * `reportedChecks` — labelled as the agent's own account, context and never
 * evidence. An empty `findingIds` list — round 1's first review — omits the
 * `FINDING_IDS:` line entirely, the same "nothing to cite" convention the
 * reviewer's own `FINDING_IDS:` grammar uses for an empty findings list.
 */
export function renderDeveloperRoundComment(
  head: string,
  findingIds: readonly string[],
  reportedChecks: readonly { command: string; outcome: 'pass' | 'fail' }[] = []
): string {
  const lines = [`Head: ${head}`]
  if (findingIds.length > 0) lines.push(`FINDING_IDS: ${findingIds.join(',')}`)
  if (reportedChecks.length > 0) {
    lines.push('', 'Checks the Developer reports running (agent-reported context, not evidence):')
    for (const check of reportedChecks) lines.push(`- \`${defangReportedCommand(check.command)}\` — ${check.outcome}`)
  }
  return lines.join('\n')
}

/**
 * A reported command as the driver's comment may carry it. The controller
 * already refuses a command with a newline or control character; this is the
 * second layer, applied to whatever reaches the renderer: every control
 * character becomes a space, so the command stays one line inside its code
 * span; a backtick becomes a quote, so it cannot close that span; an HTML
 * comment opener is escaped, so no `<!-- aeg:… -->` marker parser can match
 * it; and a `VERDICT:` label is split from its colon, the same defanging
 * forge text gets (`task-tools/pr-facts.ts`), so no verdict extractor reads it.
 */
export function defangReportedCommand(command: string): string {
  return [...command]
    .map((char) => (isControlCharacter(char) ? ' ' : char))
    .join('')
    .replaceAll('`', "'")
    .replaceAll('<!--', '&lt;!--')
    .replace(/VERDICT:/gi, (m) => `${m.slice(0, -1)} :`)
}

export function parseShortstat(stat: string): { filesChanged: number; insertions: number; deletions: number } {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat)
  if (!m) return { filesChanged: 0, insertions: 0, deletions: 0 }
  return { filesChanged: Number(m[1] ?? 0), insertions: Number(m[2] ?? 0), deletions: Number(m[3] ?? 0) }
}

/** Thrown when a round's resume attempt fails for a vendor whose previous round succeeded — Section 10's own stop-and-escalate, never a fallback to a fresh session. */
export class DevReviewLoopResumeError extends Error {}

/**
 * Thrown when the vendor refuses the dispatch because nobody is signed in
 * — the one dispatch failure that is a credential fact about this host, not
 * a fault of the task, the round, or the worker: no session was ever
 * started, so nothing was lost and there is nothing to diagnose beyond
 * signing in again. The loop pauses on it like any other thrown driver-path
 * failure, but never spends a unit of the infrastructure-retry budget on it
 * (`spendsInfrastructureRetry`), so a host that stays signed out pauses as
 * often as it must without ever forcing a Principal ruling to resume.
 */
export class DispatchSignInRefused extends Error {
  constructor(
    public readonly vendor: AgentVendor,
    subject: string
  ) {
    super(
      `devReviewLoop: ${subject} could not sign in — ${vendor} refused the dispatch (authentication-failed) ` +
        `before any session started, so no work was lost. Sign ${vendor} in on this host; the next run or ` +
        '`--resume` starts a fresh session.'
    )
    this.name = 'DispatchSignInRefused'
  }
}

/**
 * Does this round-ending error spend a unit of the loop's
 * infrastructure-retry budget? Everything does, except a sign-in refusal
 * and a GitHub rate limit (the loop already waited it out in place, or
 * pauses for the reset): that budget bounds how often a task may be resumed past a recoverable
 * hiccup with no genuine round in between, and a host with no credentials
 * never produced a round to bound — counting it would exhaust the budget
 * and demand a Principal ruling for a failure a `claude`/`codex`/`gemini`
 * login fixes. Keyed on the sign-in cause alone, never on "a pause that
 * came through this code path", so every other infrastructure loop keeps
 * its bound.
 */
export function spendsInfrastructureRetry(err: unknown): boolean {
  return !(err instanceof DispatchSignInRefused) && !isGitHubRateLimitError(err)
}

/** The rate-limit wording GitHub's REST and GraphQL APIs use, primary and secondary — nothing that merely mentions GitHub matches. */
const GITHUB_RATE_LIMIT_WORDING = /api rate limit (?:already )?exceeded|secondary rate limit|rate limit exceeded/i

/**
 * Is this error GitHub refusing a read or write because a rate limit — the
 * primary hourly one or a secondary one — is spent? Matches on the
 * rate-limit wording alone, in the error's message or its captured stderr;
 * every other uncaught error keeps the ordinary infrastructure path.
 */
export function isGitHubRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const stderr = (err as { stderr?: unknown }).stderr
  return GITHUB_RATE_LIMIT_WORDING.test(`${err.message}\n${stderr === undefined ? '' : String(stderr)}`)
}

/** How many rate-limit waits in a row, with no round progress between them, the loop makes before it pauses. */
export const MAX_CONSECUTIVE_RATE_LIMIT_WAITS = 2

/** How many times the watching driver resumes one round by itself after a rate-limit pause; past this the pause stays and a plain resume clears it. */
export const MAX_AUTOMATIC_RATE_LIMIT_RESUMES = 2

/** The wait when GitHub reports no reset time (a secondary limit does not): a few minutes. */
export const RATE_LIMIT_FALLBACK_WAIT_MS = 5 * 60 * 1000

/** Slack added past the reported reset, so the first re-read lands after the window has actually rolled over. */
const RATE_LIMIT_RESET_SLACK_MS = 5_000

/**
 * The pause detail for a rate limit the loop will not wait out again, saying
 * what actually happened: how many waits really ran before the pause. It names
 * the cause and what clears it.
 */
export function rateLimitPauseDetail(waitsRun: number): string {
  const what =
    waitsRun === 0
      ? 'GitHub refused a request at a step the loop cannot safely repeat, so it did not wait'
      : `the loop waited for the limit to reset ${waitsRun === 1 ? 'once' : `${waitsRun} times`} and was still refused`
  return `GitHub rate limit: ${what}. No ruling is needed — a plain resume continues once the limit has reset`
}

/** Does this pause detail say the pause is a GitHub rate limit, so its comment must not ask for a ruling? */
export function isRateLimitPauseDetail(detail: string | undefined): boolean {
  return detail?.startsWith('GitHub rate limit:') === true
}

/**
 * How long to wait for a rate limit to reset: until the reported reset
 * (epoch seconds, from `gh api rate_limit`, which does not count against the
 * limit) plus a little slack, or the fixed fallback when none is reported or
 * the reported time has already passed (the limit that fired is a different
 * one, a secondary limit).
 */
export function rateLimitWaitMs(resetEpochSeconds: number | null, nowMs: number): number {
  if (resetEpochSeconds === null) return RATE_LIMIT_FALLBACK_WAIT_MS
  const untilReset = resetEpochSeconds * 1000 - nowMs
  return untilReset > 0 ? untilReset + RATE_LIMIT_RESET_SLACK_MS : RATE_LIMIT_FALLBACK_WAIT_MS
}

/**
 * Ruling 986-1: the developer dispatch-success history one `devReviewLoop` run
 * keeps so a resume failure can be classified correctly. Two independent
 * facts, from the SAME latched state so they can never drift:
 *
 * - `hasSucceeded` — whether ANY developer dispatch has succeeded this run.
 *   Gates whether a resume failure is the "worked, now won't resume"
 *   stop-and-escalate at all (`assertDispatchOrEscalate`'s
 *   `previousDispatchSucceededForVendor`), rather than a plain first-dispatch
 *   failure.
 * - `succeededBeforeRound(round)` — whether a dispatch in a round STRICTLY
 *   EARLIER than `round` succeeded. This is the "worked last round, broke now"
 *   product escalation; it must NOT be confused with a same-round follow-up
 *   resume failing after this round's own earlier dispatch succeeded.
 *
 * The round is LATCHED to the FIRST success and never overwritten (round-3
 * review MAJOR): a most-recent-success tracker would move to the current round
 * when round ≥2's own main resume succeeds, after which that round's
 * same-round `COMMIT_AND_PUSH` resume failing would wrongly read as a
 * first-resume failure even though an earlier round genuinely succeeded.
 */
export class DeveloperDispatchHistory {
  private firstSuccessRound: number | null = null

  /** Records a successful developer dispatch in `round`. Latches the FIRST such round; a later success never moves it. */
  recordSuccess(round: number): void {
    if (this.firstSuccessRound === null) this.firstSuccessRound = round
  }

  /** True once any developer dispatch has succeeded this run. */
  get hasSucceeded(): boolean {
    return this.firstSuccessRound !== null
  }

  /** True when a dispatch in a round strictly earlier than `round` succeeded. */
  succeededBeforeRound(round: number): boolean {
    return this.firstSuccessRound !== null && this.firstSuccessRound < round
  }
}

export async function assertDispatchOrEscalate(
  handle: DispatchHandle,
  vendor: AgentVendor,
  isResume: boolean,
  previousDispatchSucceededForVendor: boolean,
  subject: string,
  // Ruling 986-1: whether the earlier success that makes this a
  // stop-and-escalate was in a PREVIOUS round, not this same one. False when
  // the only prior success was this round's own fresh dispatch — e.g. round
  // 1's fresh developer dispatch succeeds, then the same round's resume to
  // push/open the PR fails. The escalation is identical either way (a session
  // that worked will not resume; never fall back to a fresh one), but the
  // message must not claim "after succeeding last round" when there is no
  // last round. Defaulted so the reviewer call sites (never a resume) need
  // not pass it.
  succeededInEarlierRound = false
): Promise<void> {
  if (!handle.failureReason) return
  // Checked BEFORE the resume stop-and-escalate below: a vendor that cannot
  // sign in refuses identically whether this round was the first or the
  // tenth, so a credential failure on a resumed round is never read as the
  // "this session worked last round and broke now" product escalation.
  if (handle.failureReason === 'authentication-failed') throw new DispatchSignInRefused(vendor, subject)
  if (isResume && previousDispatchSucceededForVendor) {
    const sinceClause = succeededInEarlierRound
      ? 'after succeeding last round'
      : "on the session's first resume — its own fresh dispatch earlier this round succeeded, but the resume did not"
    throw new DevReviewLoopResumeError(
      `devReviewLoop: ${vendor}'s resume failed this round (${handle.failureReason}) ${sinceClause} — ` +
        `stop-and-escalate severity:product, vendor: ${vendor}. Never falling back to a fresh developer session (Principal ruling, 2026-09-04).`
    )
  }
  throw new Error(`devReviewLoop: dispatching ${vendor} failed (${handle.failureReason}).`)
}

/**
 * `timeoutMessage` may be a plain string or a thunk — the thunk form
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
 * The bound on consecutive
 * gate-red developer turns that produce no push on one head — small and
 * strict, since the failure mode this bounds (a real incident: five re-dispatches in
 * two minutes on one head) is a developer making no progress at all, not
 * one that needs several genuine attempts. Driver-owned rather than a
 * `packages/aeg-core` constant: this module's own declared Surface
 * puts `packages` out of scope.
 */
export const MAX_GATE_STALLED_TURNS = 2

/**
 * O2: the bound on this task's own cumulative
 * `'infrastructure'`/`'stale_driver'` pause count — never reset by a
 * restart, unlike `MAX_GATE_STALLED_TURNS` (a per-episode, in-memory
 * counter already bounded within one process's own round loop). Small: the
 * failure mode this bounds is a task that keeps hitting the driver's own
 * recoverable-hiccup class of pause and getting `--resume`d past it forever,
 * never a genuine review round that needs many honest attempts.
 */
export const MAX_INFRASTRUCTURE_RETRIES = 5

// --- authoritative loop-state recovery -------------------------------------

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
  /** The loop's two repeat detectors, so a re-exec or an attach continues counting rather than starting over — see `LoopStateRecordSchema.repeatMemory`. */
  repeatMemory: { blockingFindings: string[]; lastFailure: { signature: string; message: string } | null }
  publicationExpectedBase: string | null
  /** When the loop first started on this task, ISO-8601 — written by the first driver to persist state for it and carried forward unchanged by every later one, so the task's wall-clock budget measures from one fixed instant across restarts. */
  taskStartedAt: string
  /** Milliseconds recorded against each phase so far, including the phase this write is entering — accumulated across restarts, and narration only (the budget is decided on elapsed time). */
  phaseMs: Record<string, number>
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
      repeatMemory: snapshot.repeatMemory,
      publicationExpectedBase: snapshot.publicationExpectedBase,
      taskStartedAt: snapshot.taskStartedAt,
      phaseMs: snapshot.phaseMs,
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
 * `packages/aeg-core`, out of this module's declared Surface;
 * `Decision`/`PauseReason` themselves are unchanged). Reuses
 * `stop_condition_met`'s existing, otherwise-unused `'principal_stop'`
 * condition and `paused`'s existing generic `'principal_item'` reason —
 * the SAME schema enum members every policy-decided bounded pause already
 * reuses for confidence/reappearance/no_progress/max_rounds — never a new
 * schema value, so these events validate and land in the outbox exactly
 * like a policy-decided pause's do (a round-2 review MAJOR finding:
 * this pause used to skip the log entirely). `state` is read only for its
 * running totals; it is never written back, since the loop returns
 * immediately after this — a resume starts a fresh `LoopState` regardless
 * (`initialLoopState`, called fresh in the `--resume` path above).
 */
export function driverDecidedPauseEvents(
  loopId: string,
  state: LoopState,
  round: number,
  stats: RoundStats,
  reasonCode: string
): DevReviewLoopEventInput[] {
  const envelope = { kind: 'dev_review_loop' as const, payload: {} }
  return [
    { ...envelope, loop_id: loopId, event: 'stop_condition_met', round, condition: 'principal_stop' },
    {
      ...envelope,
      loop_id: loopId,
      event: 'paused',
      round,
      reason: 'principal_item',
      reason_code: CODE_TOKEN_PATTERN.test(reasonCode) ? reasonCode : 'unknown'
    },
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
 * `dev-review-loop.ts` (a round-2 review BLOCKER finding).
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
    { ...envelope, loop_id: loopId, event: 'paused', round, reason: 'principal_item', reason_code: 'infrastructure' },
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

/**
 * The class of a thrown value, for `driver_exited.error_class`: the error's
 * own string `code` when it has one, else its constructor name — never its
 * message or stack, which can carry a path or a secret. A value that is not
 * a short token (letters, digits, dot, dash, underscore, 64 at most) reads
 * `unknown`, so no path or message text can reach the record.
 */
export function errorClassOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  const name = typeof err === 'object' && err !== null ? err.constructor?.name : undefined
  const candidate = typeof code === 'string' && code !== '' ? code : name
  return typeof candidate === 'string' && CODE_TOKEN_PATTERN.test(candidate) ? candidate : 'unknown'
}
