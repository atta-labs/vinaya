import { devReviewLoop } from '../dev-review-loop.js'
import type { Decision } from '../../../../tools/dev-review-policy/types'
import type { LoopInput } from './driver-helpers.js'
import type { LoopDeps } from './driver-deps.js'
import type { LoopResult } from './driver-helpers.js'
import { fetchPrState } from './gate-reading.js'
import { fetchNewestRulingOrdinal } from './developer-dispatch.js'
import { readPauseState } from './pause-resume.js'
import { writePauseState } from './pause-resume.js'
import { readResolutionRecord } from './pause-resume.js'
import { clearDriverLock } from './pause-resume.js'
import { defaultGitRevParseOriginMain } from './git-defaults.js'
import { gitCommitsTouchingDriverPaths } from './gate-reading.js'
import { runtimeDir } from './reviewer-dispatch.js'
import { findOpenPrForBranch } from './developer-dispatch.js'
import { fetchMergeableState } from './gate-reading.js'
import type { DevReviewLoopEventInput } from '../../../../tools/dev-review-policy/types'
import { defaultPullDefaultBranch } from './runtime-defaults.js'
import { defaultReexecSelf } from './runtime-defaults.js'
import { defaultSleep } from './runtime-defaults.js'
import { gatePollEnvOverride } from './runtime-defaults.js'
import { defaultReadRateLimitReset } from './runtime-defaults.js'
import { log as logToDefaultSink } from '../../../../../../kernel/log/log-sink.js'
import { writeDriverLock } from './pause-resume.js'

import { isHostRepairPause } from './pause-resume.js'
import { isRateLimitPauseDetail } from './round-assess.js'
import { rateLimitResetFromDetail } from './round-assess.js'
import { isUsageLimitPauseDetail } from './round-assess.js'
import { usageLimitResetFromDetail } from './round-assess.js'
import { MAX_AUTOMATIC_RATE_LIMIT_RESUMES } from './round-assess.js'
import { usageLimitWaitMs } from './round-assess.js'
import { rateLimitWaitMs } from './round-assess.js'
import { isAgentVendor } from '../../dispatch/dispatch.js'
import { ReplayedResolutionError } from './pause-resume.js'
import { spendsInfrastructureRetry } from './round-assess.js'
import { MAX_INFRASTRUCTURE_RETRIES } from './round-assess.js'
import { isAutomaticRecoveryPause } from './pause-resume.js'
import { loopLogPathFor } from '../../../../../../kernel/log/client/loop-log.js'
import { appendDriverLine } from '../../../../../../kernel/log/client/loop-log.js'
import { readPublishedPullRequest } from './gate-reading.js'
import { MAX_AUTOMATIC_CONFLICT_REENTRIES } from './gate-reading.js'
import { conflictReentryEvent } from './driver-lifecycle.js'
import { randomUUID } from 'node:crypto'
import { narrateDriverEvent } from '../../../../../../kernel/log/client/loop-log.js'
import { conflictReentryBoundDetail } from './gate-reading.js'
import { AGENT_VENDOR_NAMES } from '../../dispatch/dispatch.js'

// --- the driver watch (issue-711 O4) ---------------------------------------

/**
 * issue-711 O4 — a pause never ends the driver. After `devReviewLoop`
 * returns a `pause` against an already-open pull request, `runDriverLoop`
 * keeps this same process running and watches that pull request rather
 * than handing back to an operator's own `--resume`. It polls three forge
 * facts — the PR's own open/merged/closed state (`fetchPrState`,
 * `gate-reading.ts`), whether a newer Principal ruling has landed since
 * this pause was posted (`fetchNewestRulingOrdinal`, "newer than the
 * pause" is O4's own wording), and whether THIS pause's own escalation has
 * been resolved `'cancel'` by someone else (`--cancel`, `task_cancel`,
 * `readResolutionRecord`) — and, the moment one of them says "continue,"
 * calls `devReviewLoop` again with EXACTLY the `{resumePr, agent, model}`
 * shape a human's own `dev-review-loop --resume <pr>` builds, never a
 * second, parallel continuation path: this is what "continues from that
 * ruling exactly as `dev-review-loop --resume <pr>` does today" (the
 * brief's own wording) means in code — the SAME function call, not a
 * reimplementation of what it does. `'infrastructure'`/`'stale_driver'`
 * pauses need no ruling at all (the same bare-resume allowance `--resume`
 * already grants them — "Pause and `--resume`", `harness/processes/vinaya-strict/loops/dev-review/loop.md`)
 * — they retry after one bounded backoff wait instead of watching for a
 * ruling. A bare retry that itself fails spends one unit of the task's
 * infrastructure-retry budget — the same count the pause record carries,
 * written back to it — and, while that count stays under
 * `MAX_INFRASTRUCTURE_RETRIES`, waits the backoff again and retries; a
 * connection failure to GitHub spends nothing and simply retries after the
 * backoff. Only at the bound does it fall back to watching for a real ruling,
 * rather than hammering the same failing bare attempt every poll tick forever.
 *
 * A pause recorded before any pull request existed (`prNumber <= 0`) has
 * no pull request to poll or read a ruling off. One that asks a Principal
 * for a decision ends the driver unwatched, as before: its own Issue comment
 * names the command that continues it, in whichever address form this
 * task's branch says `task run` takes for it (`noPushResumeArgv`,
 * `pause-resume.ts`; "Pause and `--resume`", `harness/processes/vinaya-strict/loops/dev-review/loop.md`). An
 * automatic-recovery one (`isAutomaticRecoveryPause` — an infrastructure
 * hiccup, a GitHub rate limit, a stale driver) is watched by
 * `watchPrePrPauseThenResume` instead: the same one bounded wait, then the
 * same continuation `task run` would make — the pull request opened since, if
 * there is one, bound and resumed; for every automatic-recovery pause
 * (`infrastructure` or `stale_driver`) within its retry bound, the task
 * re-entered otherwise.
 *
 * This watcher holds the task's one-driver-per-task lock for its ENTIRE
 * life — across every pause and every resume attempt it makes, never
 * cleared and re-acquired in between (`LoopInput.retainDriverLock`,
 * `DriverWatchDeps.clearDriverLock`'s own doc comment) — so a genuinely
 * separate `task run`/`--resume` for the same task is refused, naming this
 * live driver, the whole time it watches, exactly as "One driver per task"
 * (`harness/processes/vinaya-strict/loops/dev-review/loop.md`) already promises. A resume attempt this
 * watcher makes can still fail for other reasons — a benign race against
 * an operator's own concurrent `--resume`/`--cancel` (`ReplayedResolutionError`),
 * or a transient forge read. Neither crashes this unattended watcher: both
 * are reported to stderr and the SAME pause is watched again from scratch
 * after one poll interval, never treated as this driver's own final
 * decision.
 *
 * A human's own explicit `dev-review-loop --resume <pr>`/`--cancel <pr>`
 * invocation stays exactly as it was before this task — a one-shot debug/
 * direct entry, never itself a watcher (`harness/processes/vinaya-strict/loops/dev-review/loop.md`, "The
 * command"). `runDriverLoop` is what `task run` uses instead — the one
 * "normal," unattended entry — so an operator never needs to type a resume
 * command at all for the ordinary case this task exists for; `dev-review-loop`
 * (`--task`, `--resume`, `--cancel` alike) remains there for the cases it
 * always covered (an operator driving the loop or forcing a continuation/
 * stop by hand).
 */
export type DriverEndReason = 'merged' | 'closed' | 'cancelled'

/**
 * `runDriverLoop`'s own terminal decision — `Decision` (`@attalabs/aeg-core`,
 * the pure policy layer) widened by exactly the three facts above, none of
 * which `assessRound` could ever decide (they are facts about the PULL
 * REQUEST, never a round's verdicts) — never added to `Decision` itself,
 * the same "driver-decided, never a policy-layer type" precedent
 * `'infrastructure'`/`'stale_driver'` already set ("Infrastructure
 * failures", `harness/processes/vinaya-strict/loops/dev-review/loop.md`) and this task's own declared
 * Surface keeps: `packages/aeg-core` stays untouched by this member.
 */
export type DriverDecision = Decision | { type: 'ended'; reason: DriverEndReason }

export type DriverResult = { finalDecision: DriverDecision; prNumber: number; task: number }

export type DriverWatchDeps = {
  /** Defaults to the real `devReviewLoop` — every resume attempt this watcher makes goes through it unchanged, threading the SAME caller-supplied `loopDeps` every time (a test's in-process harness included). */
  devReviewLoop: (input: LoopInput, deps?: Partial<LoopDeps>) => Promise<LoopResult>
  fetchPrState: typeof fetchPrState
  fetchNewestRulingOrdinal: typeof fetchNewestRulingOrdinal
  readPauseState: typeof readPauseState
  /** Writes back the pause record's infrastructure-retry count after a failed bare retry spends one. */
  writePauseState: typeof writePauseState
  readResolutionRecord: typeof readResolutionRecord
  /**
   * issue-711 O4 (code review round 1, BLOCKER; round 2, MAJOR/security
   * LOW): `runDriverLoop` holds the one-driver-per-task lock for its
   * ENTIRE life, across every pause and every resume attempt this same
   * process makes (`LoopInput.retainDriverLock` — `devReviewLoop`'s own
   * doc comment — carrying the one random token this run generated at its
   * own start), never clearing and re-acquiring it in between: a "clear,
   * then call back in" gap would briefly open the task to a genuinely
   * concurrent second `task run`, exactly the race "One driver per task"
   * (`harness/processes/vinaya-strict/loops/dev-review/loop.md`) exists to prevent. `devReviewLoop`'s own
   * entry gate recognizes a lock as THIS run's own only when it names both
   * this pid AND this exact token — a bare pid match is never enough (the
   * OS can reissue a crashed driver's exact pid to a fresh, unrelated
   * invocation for the same task) — so the same lock simply continues,
   * unbroken, under this one process the whole time. This field's only
   * caller is `runDriverLoop` itself, at the ONE point that actually ends
   * the driver: once the watch loop decides the task is genuinely over
   * (merged, closed, cancelled), releasing a lock `devReviewLoop`'s own
   * `finally` never ran for that exit.
   */
  clearDriverLock: typeof clearDriverLock
  /** The default branch watermark captured once when this watching driver starts. */
  gitRevParseOriginMain: typeof defaultGitRevParseOriginMain
  /** Driver-owned commits between the watcher's start watermark and the current default-branch head. */
  gitCommitsTouchingDriverPaths: typeof gitCommitsTouchingDriverPaths
  /** Updates this checkout before a stale watching driver hands the task to a fresh process. */
  pullDefaultBranch: () => { ok: true } | { ok: false; reason: string }
  /** Starts the fresh driver after a stale-watcher hand-off; `null` means the spawn did not start. */
  reexecSelf: (args: string[]) => number | null
  /** Exits with the fresh driver's code after a successful hand-off. */
  exitProcess: (code: number) => never
  runtimeDir: () => string
  sleep: (ms: number) => Promise<void>
  /** How often this watcher polls the PR/resolution/ruling while nothing is yet ready — env-overridable (`VINAYA_DEV_REVIEW_LOOP_WATCH_POLL_MS`) for a fast fixture; real usage never needs sub-second spacing. */
  watchPollIntervalMs: number
  /** The single bounded wait an `'infrastructure'`/`'stale_driver'` pause takes before its own bare-resume retry — env-overridable (`VINAYA_DEV_REVIEW_LOOP_WATCH_INFRA_BACKOFF_MS`). */
  infrastructureBackoffMs: number
  /** Reads the GitHub rate-limit reset (epoch seconds) once, without spending the limit — the same read the in-round wait makes. */
  readRateLimitReset: () => Promise<number | null>
  now: () => number
  /** The open pull request on a branch — how a pause recorded before any pull request existed finds the one opened since, to bind and resume it. */
  findOpenPrForBranch: typeof findOpenPrForBranch
  /** The forge's mergeability of a published pull request, read on each watch tick — `UNKNOWN` is read again on the next. */
  fetchMergeableState: typeof fetchMergeableState
  /** Where an automatic conflict re-entry's `conflict_reentry` event goes — the Vinaya Log. */
  logEvent: (event: DevReviewLoopEventInput) => void
}

/** One driver run's count of automatic rate-limit resumes, kept across pauses so the bound survives each re-watch; keyed by the round the pauses belong to. */
export type RateLimitResumeBudget = { round: number; count: number }

export function defaultDriverWatchDeps(): DriverWatchDeps {
  return {
    devReviewLoop,
    fetchPrState,
    fetchNewestRulingOrdinal,
    readPauseState,
    writePauseState,
    readResolutionRecord,
    clearDriverLock,
    gitRevParseOriginMain: defaultGitRevParseOriginMain,
    gitCommitsTouchingDriverPaths,
    pullDefaultBranch: defaultPullDefaultBranch,
    reexecSelf: defaultReexecSelf,
    exitProcess: (code) => process.exit(code),
    runtimeDir,
    sleep: defaultSleep,
    watchPollIntervalMs: gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_WATCH_POLL_MS', 30_000),
    infrastructureBackoffMs: gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_WATCH_INFRA_BACKOFF_MS', 60_000),
    readRateLimitReset: defaultReadRateLimitReset,
    now: () => Date.now(),
    findOpenPrForBranch,
    fetchMergeableState,
    logEvent: (event) => logToDefaultSink(event)
  }
}

/**
 * Before a watcher re-enters this process, hand it to a fresh driver when a
 * merged driver fix made this process stale. This deliberately runs at the
 * watcher seam, before `--resume` can consume a newly posted ruling.
 *
 * `true` means this watcher must stop: a real hand-off exits this process,
 * while a failed pull or spawn leaves the existing pause intact rather than
 * allowing old code to continue it in-process.
 */
export function handOffStaleWatchingDriver(
  baseHeadAtStart: string,
  continuation: LoopInput,
  task: number,
  driverLockToken: string,
  w: DriverWatchDeps,
  watch?: DriverCarry
): boolean {
  const currentBaseHead = w.gitRevParseOriginMain()
  if (currentBaseHead === baseHeadAtStart) return false
  const touching = w.gitCommitsTouchingDriverPaths(baseHeadAtStart, currentBaseHead)
  if (touching.length === 0) return false

  const args = continuation.agent
    ? [
        'dev-review-loop',
        ...('resumePr' in continuation ? ['--resume', String(continuation.resumePr)] : ['--task', String(task)]),
        // A published pull request's watch is handed to a fresh WATCHING
        // driver, carrying its re-entry count (and a spent bound's pause)
        // forward, so the hand-off neither drops the watch nor resets the bound.
        ...(watch ? driverCarryArgs(watch) : []),
        '--agent',
        continuation.agent,
        ...(continuation.model ? ['--model', continuation.model] : [])
      ]
    : null
  if (!args) throw new Error('stale watcher hand-off requires a resolved agent')

  const pulled = w.pullDefaultBranch()
  if (!pulled.ok) {
    process.stderr.write(
      `vinaya dev-review-loop: watcher's stale-driver hand-off for task ${task} failed to pull the default branch: ${pulled.reason}; the task remains paused.\n`
    )
    return true
  }

  // Match the in-loop restart: the child needs to acquire the lock before
  // this process exits. Restore it if spawning did not begin.
  w.clearDriverLock(w.runtimeDir(), task)
  const exitCode = w.reexecSelf(args)
  if (exitCode === null) {
    writeDriverLock(w.runtimeDir(), task, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: driverLockToken
    })
    process.stderr.write(
      `vinaya dev-review-loop: watcher's stale-driver hand-off for task ${task} could not start \`vinaya ${args.join(' ')}\`; the task remains paused.\n`
    )
    return true
  }
  // The production implementation never returns from this call. The return
  // keeps injected test exits from falling through to an old-code resume.
  w.exitProcess(exitCode)
  return true
}

/**
 * What a stale published-pull-request watch hands its fresh driver
 * (`handOffStaleWatchingDriver`): the automatic conflict re-entries already
 * spent on the pull request, and — once they are spent — the bound's pause
 * detail, which the fresh driver's first run pauses on instead of sending the
 * Developer back again.
 */
export type DriverCarry = { conflictReentries?: number; pauseOnConflict?: string }

/** Pure: the `dev-review-loop --watch` argv that carries `carry` into the fresh watching driver. */
export function driverCarryArgs(carry: DriverCarry): string[] {
  return [
    '--watch',
    '--conflict-reentries',
    String(carry.conflictReentries ?? 0),
    ...(carry.pauseOnConflict !== undefined ? ['--pause-on-conflict', carry.pauseOnConflict] : [])
  ]
}

/**
 * A watch-loop forge read that fails is "cannot tell yet," never a crash —
 * the same tolerance a resume attempt itself already gets (below): reported
 * to stderr, `fallback` returned, so the caller's own next poll simply
 * tries again rather than this unattended watcher dying over a transient
 * `gh` hiccup.
 */
export function watchReadOrFallback<T>(label: string, read: () => T, fallback: T): T {
  try {
    return read()
  } catch (err) {
    process.stderr.write(
      `vinaya dev-review-loop: watcher's ${label} read failed — ${
        err instanceof Error ? err.message : String(err)
      }; still watching.\n`
    )
    return fallback
  }
}

/**
 * Writes a failed bare retry's spent count back to the pause record it
 * belongs to, so `--resume`'s own bound check (which floors on the record)
 * and every later resume count it. Best-effort, like the watch loop's reads:
 * a failed write is reported and the in-memory count still bounds this
 * watcher. A record that has since moved on to another pause is left alone.
 */
export function recordWatcherInfrastructureRetry(
  w: DriverWatchDeps,
  task: number,
  escalationId: string | null,
  infrastructureRetries: number
): void {
  try {
    const current = w.readPauseState(w.runtimeDir(), task)
    if (current === null || (current.escalationId ?? null) !== escalationId) return
    w.writePauseState(w.runtimeDir(), { ...current, infrastructureRetries })
  } catch (err) {
    process.stderr.write(
      `vinaya dev-review-loop: watcher could not record a spent infrastructure retry for task ${task} — ${
        err instanceof Error ? err.message : String(err)
      }; still watching.\n`
    )
  }
}

/**
 * One pause's own watch cycle: polls until the pull request is genuinely
 * done (merged/closed/cancelled) or a resume attempt against it returns a
 * fresh `LoopResult` — `runDriverLoop`'s own doc comment names the three
 * `'ended'` exits as the only other way out of this deliberately unbounded,
 * unattended wait.
 */
export async function watchPauseThenResume(
  pauseResult: LoopResult,
  loopDeps: Partial<LoopDeps>,
  w: DriverWatchDeps,
  driverLockToken: string,
  rateLimitBudget: RateLimitResumeBudget,
  baseHeadAtStart: string
): Promise<
  { kind: 'ended'; reason: DriverEndReason } | { kind: 'result'; result: LoopResult } | { kind: 'unwatched' }
> {
  const { prNumber, task } = pauseResult
  const reason = pauseResult.finalDecision.type === 'pause' ? pauseResult.finalDecision.reason : undefined
  // A host-repair pause is never resumed by this watcher, not even on a
  // ruling: the driver ends, its lock freed, and the ordinary start
  // continues the task once the host is repaired.
  if (reason !== undefined && isHostRepairPause(reason)) return { kind: 'unwatched' }
  let isBoundedRetry = reason === 'infrastructure' || reason === 'stale_driver'
  // A GitHub rate-limit pause is told from the recorded pause detail
  // (`rateLimitPauseDetail`'s own prefix), never from comment text. Its
  // resume waits for the reset instead of the fixed backoff, and is
  // automatic at most `MAX_AUTOMATIC_RATE_LIMIT_RESUMES` times for one
  // round: past that the pause stays and a plain resume (or a ruling) clears it.
  let isRateLimitPause = false
  // An agent's usage-limit pause is told the same way, from its detail's own
  // prefix, and shares the bounded automatic-resume count. It resumes after
  // its reset only when that reset is at most six hours away; otherwise it
  // is not a bounded retry and the pause stays for the Principal.
  let isUsageLimitPause = false
  let usageLimitResetMs: number | null = null
  // The reset a rate-limit pause recorded — a CI job's own budget, when the
  // limit reached the loop through a red check — slept to instead of this
  // host's own reset, which belongs to a different token.
  let recordedRateLimitReset: number | null = null
  const classifyRateLimitPause = (pause: { round?: number; detail?: string } | null | undefined): void => {
    isRateLimitPause = isRateLimitPauseDetail(pause?.detail)
    recordedRateLimitReset = rateLimitResetFromDetail(pause?.detail)
    isUsageLimitPause = isUsageLimitPauseDetail(pause?.detail)
    if (!isRateLimitPause && !isUsageLimitPause) return
    const round = pause?.round ?? -1
    if (rateLimitBudget.round !== round) {
      rateLimitBudget.round = round
      rateLimitBudget.count = 0
    }
    usageLimitResetMs = isUsageLimitPause ? usageLimitResetFromDetail(pause?.detail) : null
    isBoundedRetry =
      rateLimitBudget.count < MAX_AUTOMATIC_RATE_LIMIT_RESUMES &&
      (!isUsageLimitPause || usageLimitWaitMs(usageLimitResetMs, w.now()) !== null)
  }
  // Read once, right as this pause begins being watched — this IS the
  // pause `devReviewLoop` just wrote `pause-state.json` for, so it is never
  // null here (unlike a `--resume` invoked well after the fact, which must
  // tolerate a pause that has since been superseded).
  const held = w.readPauseState(w.runtimeDir(), task)
  let agent = held?.agent
  let model = held?.model
  classifyRateLimitPause(
    held ?? { detail: pauseResult.finalDecision.type === 'pause' ? pauseResult.finalDecision.detail : undefined }
  )
  let escalationId = held?.escalationId ?? null
  // "Newer than the pause" (O4's own wording) — captured now, the moment
  // this pause starts being watched, never re-derived from the pause's own
  // recorded time: a ruling that already existed when this pause posted
  // must not immediately re-trigger a resume this pause's own round
  // already accounted for.
  let baselineOrdinal = watchReadOrFallback('newest ruling ordinal', () => w.fetchNewestRulingOrdinal(prNumber), 0)
  let backoffDone = !isBoundedRetry
  // The task's infrastructure retries spent so far — the count the pause
  // record carries. A failed bare retry of an `infrastructure`/`stale_driver`
  // pause spends one more (`spendsInfrastructureRetry`) and is written back.
  let infrastructureRetriesSpent = held?.infrastructureRetries ?? 0
  // Set once a bare (no-ruling) retry can no longer be made: the task's
  // infrastructure retries reached `MAX_INFRASTRUCTURE_RETRIES`, a rate- or
  // usage-limit resume failed, or the resolution was already consumed. This
  // pause then falls back to watching for a real ruling from here on, rather
  // than re-attempting the same failing bare call every poll tick forever.
  let bareRetryExhausted = false
  // Set once a resume attempt was refused as already consumed: from then on
  // the run may be anywhere (a later round, a newer pause an operator's own
  // `--resume` led to), so every poll re-reads the current pause and
  // follows it rather than the one captured when watching began.
  let replayedOnce = false
  let hostRepairFollowed = false
  const followCurrentPause = (): void => {
    const current = watchReadOrFallback('pause state', () => w.readPauseState(w.runtimeDir(), task), null)
    if (!current?.escalationId || current.escalationId === escalationId) return
    hostRepairFollowed = isHostRepairPause(current.reason)
    escalationId = current.escalationId
    agent = current.agent
    model = current.model
    infrastructureRetriesSpent = current.infrastructureRetries ?? 0
    bareRetryExhausted = false
    isBoundedRetry = current.reason === 'infrastructure' || current.reason === 'stale_driver'
    classifyRateLimitPause(current)
    backoffDone = !isBoundedRetry
    baselineOrdinal = Math.max(
      baselineOrdinal,
      watchReadOrFallback('newest ruling ordinal', () => w.fetchNewestRulingOrdinal(prNumber), baselineOrdinal)
    )
  }

  while (true) {
    if (replayedOnce) followCurrentPause()
    if (hostRepairFollowed) return { kind: 'unwatched' }
    // A usage limit that resets past six hours (or names no reset) ends the
    // watch: the pause's own comment says so and names the command that continues it.
    if (isUsageLimitPause && !isBoundedRetry) return { kind: 'unwatched' }
    const prState = watchReadOrFallback('pull-request state', () => w.fetchPrState(prNumber), 'OPEN' as const)
    if (prState === 'MERGED') return { kind: 'ended', reason: 'merged' }
    if (prState === 'CLOSED') return { kind: 'ended', reason: 'closed' }

    const watchedEscalationId = escalationId
    if (watchedEscalationId) {
      const resolution = watchReadOrFallback(
        'resolution',
        () => w.readResolutionRecord(task, watchedEscalationId),
        null
      )
      if (resolution?.decision === 'cancel') return { kind: 'ended', reason: 'cancelled' }
    }

    if (isBoundedRetry && !backoffDone) {
      if (isUsageLimitPause) {
        // The agent's own reset, recorded in the pause — slept to, never polled.
        rateLimitBudget.count += 1
        await w.sleep(usageLimitWaitMs(usageLimitResetMs, w.now()) ?? 0)
      } else if (isRateLimitPause) {
        // The recorded reset, or else this host's, read once and slept to —
        // never polled.
        rateLimitBudget.count += 1
        const reset = recordedRateLimitReset ?? (await w.readRateLimitReset())
        await w.sleep(rateLimitWaitMs(reset, w.now()))
      } else {
        await w.sleep(w.infrastructureBackoffMs)
      }
      backoffDone = true
      // Re-check the three exits above once more, right after the wait,
      // before ever attempting the bare resume below — never fire a resume
      // at a pull request that concluded while this driver slept.
      continue
    }

    const readyForBareRetry = isBoundedRetry && !bareRetryExhausted
    const readyForRuling =
      watchReadOrFallback('newest ruling ordinal', () => w.fetchNewestRulingOrdinal(prNumber), baselineOrdinal) >
      baselineOrdinal
    if (readyForBareRetry || readyForRuling) {
      const continuation: LoopInput = {
        resumePr: prNumber,
        ...(agent !== undefined && isAgentVendor(agent) ? { agent } : {}),
        ...(model ? { model } : {})
      }
      if (handOffStaleWatchingDriver(baseHeadAtStart, continuation, task, driverLockToken, w))
        return { kind: 'unwatched' }
      try {
        const result = await w.devReviewLoop(
          {
            ...continuation,
            // issue-711 O4 (code review round 1, BLOCKER/MEDIUM; round 2,
            // MAJOR/security LOW): this call is the SAME process
            // re-entering the SAME task's driver lock it has held, unbroken
            // and under the SAME token, since it first paused — never
            // cleared first any more (that briefly opened the task to a
            // genuinely concurrent second driver). `devReviewLoop`'s own
            // entry gate recognizes its own pid AND its own token on the
            // existing lock and neither refuses nor re-races it.
            retainDriverLock: driverLockToken
          },
          loopDeps
        )
        return { kind: 'result', result }
      } catch (err) {
        if (readyForBareRetry && !readyForRuling && !(err instanceof ReplayedResolutionError)) {
          if (isRateLimitPause || isUsageLimitPause) {
            bareRetryExhausted = true
          } else {
            // A failed bare retry of an infrastructure hiccup is one more
            // hiccup: it spends the same budget the pause record carries,
            // and is retried after the backoff while that budget lasts.
            if (spendsInfrastructureRetry(err)) {
              infrastructureRetriesSpent += 1
              recordWatcherInfrastructureRetry(w, task, escalationId, infrastructureRetriesSpent)
            }
            if (infrastructureRetriesSpent < MAX_INFRASTRUCTURE_RETRIES) backoffDone = false
            else bareRetryExhausted = true
          }
        }
        if (err instanceof ReplayedResolutionError) {
          // This pause's resolution was already consumed — by an operator's
          // own `--resume`, or by an earlier attempt of this very watcher.
          // Retrying it can never succeed, so it is never retried: re-read
          // the CURRENT pause, advance the baseline to the newest ruling
          // observed, and act only on a strictly newer one (or on a newer
          // pause the run has since moved on to).
          bareRetryExhausted = true
          const observed = watchReadOrFallback(
            'newest ruling ordinal',
            () => w.fetchNewestRulingOrdinal(prNumber),
            baselineOrdinal
          )
          baselineOrdinal = Math.max(baselineOrdinal, observed)
          replayedOnce = true
          followCurrentPause()
        }
        // A benign race (an operator's own concurrent `--resume`, a
        // replayed resolution, a transient forge read) — never this
        // watcher's own final decision. Reported, then the SAME pause is
        // watched again from scratch.
        process.stderr.write(
          `vinaya dev-review-loop: watcher's resume attempt for PR #${prNumber} failed — ${
            err instanceof Error ? err.message : String(err)
          }; still watching.\n`
        )
      }
    }

    await w.sleep(w.watchPollIntervalMs)
  }
}

/**
 * One automatic-recovery pause recorded before any pull request existed,
 * watched the way `watchPauseThenResume` watches one on a pull request: the
 * same one bounded wait — until the GitHub rate-limit reset for a rate limit,
 * at most `MAX_AUTOMATIC_RATE_LIMIT_RESUMES` times for one round; the fixed
 * backoff otherwise, while the task's own `MAX_INFRASTRUCTURE_RETRIES`
 * bare-resume budget lasts — then one continuation, the same one `task run`
 * makes: the open pull request on the pause's own branch, if one was opened
 * since, through `--resume` (which binds the pause to it first); the task
 * itself otherwise, for every automatic-recovery pause (`infrastructure` or
 * `stale_driver`) still within its retry bound. A pause asking a
 * Principal for a decision, a spent budget, a cancel, or a continuation that
 * throws all end the driver as before (`'unwatched'`) — its Issue comment, or the thrown refusal, names
 * what continues it. Every attempt re-enters under this driver's own lock
 * token, so no second driver ever starts.
 */
export async function watchPrePrPauseThenResume(
  pauseResult: LoopResult,
  input: LoopInput,
  loopDeps: Partial<LoopDeps>,
  w: DriverWatchDeps,
  driverLockToken: string,
  rateLimitBudget: RateLimitResumeBudget,
  baseHeadAtStart: string
): Promise<
  { kind: 'ended'; reason: DriverEndReason } | { kind: 'result'; result: LoopResult } | { kind: 'unwatched' }
> {
  const { task } = pauseResult
  if (pauseResult.finalDecision.type !== 'pause') return { kind: 'unwatched' }
  const held = watchReadOrFallback('pause state', () => w.readPauseState(w.runtimeDir(), task), null)
  if (!held || held.prNumber !== null || !isAutomaticRecoveryPause(held.reason)) return { kind: 'unwatched' }
  const agent = held.agent !== undefined && isAgentVendor(held.agent) ? held.agent : input.agent
  if (!agent) return { kind: 'unwatched' }

  if (isRateLimitPauseDetail(held.detail)) {
    if (rateLimitBudget.round !== held.round) {
      rateLimitBudget.round = held.round
      rateLimitBudget.count = 0
    }
    if (rateLimitBudget.count >= MAX_AUTOMATIC_RATE_LIMIT_RESUMES) return { kind: 'unwatched' }
    rateLimitBudget.count += 1
    const reset = rateLimitResetFromDetail(held.detail) ?? (await w.readRateLimitReset())
    await w.sleep(rateLimitWaitMs(reset, w.now()))
  } else if (isUsageLimitPauseDetail(held.detail)) {
    // The agent's own reset, recorded in the pause; past six hours (or none
    // given) the pause is left for the Principal.
    const waitMs = usageLimitWaitMs(usageLimitResetFromDetail(held.detail), w.now())
    if (waitMs === null) return { kind: 'unwatched' }
    if (rateLimitBudget.round !== held.round) {
      rateLimitBudget.round = held.round
      rateLimitBudget.count = 0
    }
    if (rateLimitBudget.count >= MAX_AUTOMATIC_RATE_LIMIT_RESUMES) return { kind: 'unwatched' }
    rateLimitBudget.count += 1
    await w.sleep(waitMs)
  } else {
    if ((held.infrastructureRetries ?? 0) >= MAX_INFRASTRUCTURE_RETRIES) return { kind: 'unwatched' }
    await w.sleep(w.infrastructureBackoffMs)
  }

  const escalationId = held.escalationId
  if (escalationId) {
    const resolution = watchReadOrFallback('resolution', () => w.readResolutionRecord(task, escalationId), null)
    if (resolution?.decision === 'cancel') return { kind: 'ended', reason: 'cancelled' }
  }
  const openPr = watchReadOrFallback('open pull request', () => w.findOpenPrForBranch(held.branch), null)
  // Both automatic-recovery reasons can re-enter the task bare when no pull
  // request exists yet. This is the same bounded allowance `--resume` grants
  // them after a PR is available; the watcher owns only the wait and lock.
  const model = held.model ?? input.model
  const continuation: LoopInput = openPr
    ? { resumePr: openPr.number, agent, ...(model ? { model } : {}) }
    : { task, agent, ...(model ? { model } : {}) }
  if (handOffStaleWatchingDriver(baseHeadAtStart, continuation, task, driverLockToken, w)) return { kind: 'unwatched' }
  try {
    return {
      kind: 'result',
      result: await w.devReviewLoop({ ...continuation, retainDriverLock: driverLockToken }, loopDeps)
    }
  } catch (err) {
    process.stderr.write(
      `vinaya dev-review-loop: watcher's resume attempt for task ${task} failed — ${
        err instanceof Error ? err.message : String(err)
      }; the driver stops watching.\n`
    )
    return { kind: 'unwatched' }
  }
}

/**
 * A `publish` does not end a task under the watching driver: until the pull
 * request is merged or closed, the default branch can move under it and
 * leave it conflicting, and nothing else would pick the task up again. Each
 * poll reads the pull request's state, then its forge mergeability
 * (`readPublishedPullRequest`): merged or closed ends the watch, and
 * `UNKNOWN` is read again on the next poll, never taken as conflicting or
 * clean. A `CONFLICTING` read re-enters `devReviewLoop` as `task run` would —
 * `--task`, under this driver's own lock token, never `--resume`, so no ruling
 * is needed — and that run's attach reads the same conflict and sends the
 * Developer back with the conflicting files through the existing conflict
 * send-back; the gates and both reviews run again on the new head before
 * anything publishes. A base that moved over this driver's own code hands the
 * task to a fresh watching driver first (`handOffStaleWatchingDriver`, after
 * this re-entry is counted and narrated, carrying the count), so it resumes on
 * current code, never by rewriting history, and the watch and the bound survive.
 *
 * Each re-entry is counted against `MAX_AUTOMATIC_CONFLICT_REENTRIES` and
 * narrated in the per-task driver log and the Log (`conflict_reentry`). Once
 * they are spent, the next conflict re-enters with `pauseOnConflict`: that run
 * pauses `repeat_failure` through the ordinary pause and its comment, and
 * `runDriverLoop` ends its watch on it. A re-entry that throws is reported and
 * the watch polls again; a failed forge read is "cannot tell yet".
 */
export async function watchPublishedPullRequest(
  published: LoopResult,
  input: LoopInput,
  loopDeps: Partial<LoopDeps>,
  w: DriverWatchDeps,
  driverLockToken: string,
  baseHeadAtStart: string,
  reentries: { count: number }
): Promise<
  | { kind: 'ended'; reason: 'merged' | 'closed' }
  | { kind: 'result'; result: LoopResult; boundSpent: boolean }
  | { kind: 'unwatched' }
> {
  const { prNumber, task } = published
  const held = watchReadOrFallback('pause state', () => w.readPauseState(w.runtimeDir(), task), null)
  const agent = input.agent ?? (held?.agent !== undefined && isAgentVendor(held.agent) ? held.agent : undefined)
  if (!agent) {
    process.stderr.write(
      `vinaya dev-review-loop: task ${task} records no agent to re-enter PR #${prNumber} with; the driver stops watching it.\n`
    )
    return { kind: 'unwatched' }
  }
  const model = input.model ?? held?.model
  const loopLogPath = loopLogPathFor(null, task)
  appendDriverLine(loopLogPath, `Watching PR #${prNumber} after its publication, until it is merged or closed.`)
  while (true) {
    const read = watchReadOrFallback(
      'published pull request',
      () => readPublishedPullRequest(prNumber, w),
      'watching' as const
    )
    if (read === 'merged' || read === 'closed') return { kind: 'ended', reason: read }
    if (read === 'conflicting') {
      const continuation: LoopInput = { task, agent, ...(model ? { model } : {}) }
      const boundSpent = reentries.count >= MAX_AUTOMATIC_CONFLICT_REENTRIES
      if (boundSpent) {
        appendDriverLine(
          loopLogPath,
          `PR #${prNumber} fell into conflict with the default branch again, and its ${MAX_AUTOMATIC_CONFLICT_REENTRIES} automatic re-entries are spent: the loop pauses for a person.`,
          'waiting'
        )
      } else {
        reentries.count += 1
        const event = conflictReentryEvent({
          loopId: randomUUID(),
          task,
          prNumber,
          attempt: reentries.count,
          bound: MAX_AUTOMATIC_CONFLICT_REENTRIES
        })
        w.logEvent(event)
        narrateDriverEvent(loopLogPath, event, [], task)
      }
      const pauseOnConflict = boundSpent
        ? conflictReentryBoundDetail(prNumber, MAX_AUTOMATIC_CONFLICT_REENTRIES)
        : undefined
      // Counted and narrated first, so a hand-off to current code carries
      // this re-entry, and the count, into the fresh watching driver.
      if (
        handOffStaleWatchingDriver(baseHeadAtStart, continuation, task, driverLockToken, w, {
          conflictReentries: reentries.count,
          ...(pauseOnConflict !== undefined ? { pauseOnConflict } : {})
        })
      )
        return { kind: 'unwatched' }
      try {
        const result = await w.devReviewLoop(
          {
            ...continuation,
            retainDriverLock: driverLockToken,
            ...(pauseOnConflict !== undefined ? { pauseOnConflict } : {})
          },
          loopDeps
        )
        return { kind: 'result', result, boundSpent }
      } catch (err) {
        process.stderr.write(
          `vinaya dev-review-loop: watcher's conflict re-entry for PR #${prNumber} failed — ${
            err instanceof Error ? err.message : String(err)
          }; still watching.\n`
        )
      }
    }
    await w.sleep(w.watchPollIntervalMs)
  }
}

/**
 * issue-711 O4's own entry point — `harness/processes/vinaya-strict/loops/dev-review/standalone/bin/dev-review-loop.ts`'s
 * `--task` start and `task-run.ts`'s `runTask` both call this instead of
 * `devReviewLoop` directly (a human's own explicit `--resume <pr>`/
 * `--cancel <pr>` stay one-shot, unchanged — see this function's own
 * module doc comment, above). One call in, one `DriverResult` out, however
 * many pause/resume cycles it takes underneath. A publish is watched too
 * (`watchPublishedPullRequest`): the driver returns it once the pull request
 * is merged, ends `closed` once it is closed, and re-enters it on a conflict.
 */
export async function runDriverLoop(
  input: LoopInput,
  loopDeps: Partial<LoopDeps> = {},
  watchDeps: Partial<DriverWatchDeps> = {},
  carry: DriverCarry = {}
): Promise<DriverResult> {
  const w: DriverWatchDeps = { ...defaultDriverWatchDeps(), ...watchDeps }
  // Existing in-process loop fixtures already inject this git read through
  // LoopDeps. Prefer that seam unless a watcher-specific fake was supplied.
  if (!watchDeps.gitRevParseOriginMain && loopDeps.gitRevParseOriginMain) {
    w.gitRevParseOriginMain = loopDeps.gitRevParseOriginMain
  }
  // issue-711 O4 (code review round 1, BLOCKER; round 2, MAJOR/security
  // LOW): ONE token for this whole driver run, generated once, here, and
  // threaded into EVERY call this run makes (this first one and every
  // resume attempt `watchPauseThenResume` makes) via `retainDriverLock` —
  // this is what lets `devReviewLoop`'s own entry gate tell "this exact
  // run, re-entering its own lock" apart from a same-pid coincidence with
  // no real ownership behind it (a crashed run's pid reissued by the OS to
  // a fresh, unrelated invocation).
  const driverLockToken = randomUUID()
  // A watcher can pause for a long time. Its watermark belongs to this
  // process, not module state or each resumed loop entry.
  const baseHeadAtStart = w.gitRevParseOriginMain()
  const rateLimitBudget: RateLimitResumeBudget = { round: -1, count: 0 }
  // This driver's automatic conflict re-entries of its published pull
  // request, counted across every publish it watches — and across a stale
  // watcher's hand-off, which carries the count into this fresh driver.
  const conflictReentries = { count: carry.conflictReentries ?? 0 }
  let result = await w.devReviewLoop(
    {
      ...input,
      retainDriverLock: driverLockToken,
      ...(carry.pauseOnConflict !== undefined ? { pauseOnConflict: carry.pauseOnConflict } : {})
    },
    loopDeps
  )
  if (carry.pauseOnConflict !== undefined && result.finalDecision.type === 'pause') {
    // A handed-off watch whose re-entry bound was already spent: this run
    // paused for a person, so the watch ends on that pause.
    w.clearDriverLock(w.runtimeDir(), result.task)
    return result
  }
  for (;;) {
    if (result.finalDecision.type === 'publish' && result.prNumber > 0) {
      const watched = await watchPublishedPullRequest(
        result,
        input,
        loopDeps,
        w,
        driverLockToken,
        baseHeadAtStart,
        conflictReentries
      )
      if (watched.kind === 'unwatched') return result
      if (watched.kind === 'ended') {
        // Merged or closed: the task is over, and the lock the watched
        // publish kept is released here.
        w.clearDriverLock(w.runtimeDir(), result.task)
        return watched.reason === 'merged'
          ? result
          : { finalDecision: { type: 'ended', reason: 'closed' }, prNumber: result.prNumber, task: result.task }
      }
      result = watched.result
      if (watched.boundSpent && result.finalDecision.type === 'pause') {
        // The re-entry bound is spent and the run paused for a person: the
        // watch ends on that pause, its comment naming what continues it.
        w.clearDriverLock(w.runtimeDir(), result.task)
        return result
      }
      continue
    }
    if (result.finalDecision.type !== 'pause') return result
    const outcome =
      result.prNumber > 0
        ? await watchPauseThenResume(result, loopDeps, w, driverLockToken, rateLimitBudget, baseHeadAtStart)
        : await watchPrePrPauseThenResume(result, input, loopDeps, w, driverLockToken, rateLimitBudget, baseHeadAtStart)
    // A pause before any pull request that this driver does not (or no
    // longer may) resume by itself ends it here, its Issue comment naming the
    // continuation — the lock is left for the next start to take over, as it
    // always was for this pause.
    if (outcome.kind === 'unwatched') return result
    if (outcome.kind === 'ended') {
      // The task is genuinely over — the ONE place this driver's own lock
      // is released outside `devReviewLoop`'s own finally (which never ran
      // for this exit: nothing paused or published here, the watch loop
      // itself decided "done"). Best-effort by convention with every other
      // `clearDriverLock` call in this file — a failed unlink here still
      // leaves the task correctly finished; a stale lock naming a now-dead
      // pid is taken over by the very next start, same as any crash.
      w.clearDriverLock(w.runtimeDir(), result.task)
      return {
        finalDecision: { type: 'ended', reason: outcome.reason },
        prNumber: result.prNumber,
        task: result.task
      }
    }
    result = outcome.result
  }
}

export const DEV_REVIEW_LOOP_AGENTS = AGENT_VENDOR_NAMES
