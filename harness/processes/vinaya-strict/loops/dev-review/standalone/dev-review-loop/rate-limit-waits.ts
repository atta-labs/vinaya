import { gatePollEnvOverride } from './runtime-defaults.js'
/**
 * `dev-review-loop`'s waits on the forge: a GitHub rate limit waited out to its reset, a connection failure
 * retried in place, and the read wrappers that absorb either. Moved out of
 * `harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop.ts` verbatim, over the run's
 * `LoopRunContext`; the bodies are unchanged.
 */

import { appendDriverLine } from '../../../../../../kernel/log/client/loop-log.js'
import {
  GitHubKeptAnswering,
  GITHUB_REACHABILITY_INTERVAL_MS,
  isGitHubRateLimitError,
  MAX_ANSWERED_CONNECTION_RETRIES,
  MAX_CONSECUTIVE_RATE_LIMIT_WAITS,
  assessRateLimitedRed,
  RateLimitWaitsSpent,
  rateLimitWaitMs
} from './round-assess.js'
import { rerunFailedWorkflowsOn, waitForGreenGate } from './ci-gate.js'
import type { LoopRunContext } from './run-context.js'

/**
 * Waits out one GitHub rate limit, or rethrows `err` when it is no rate
 * limit or the wait is spent: `MAX_CONSECUTIVE_RATE_LIMIT_WAITS`
 * consecutive waits with no round progress between them. The reset is
 * read once, never polled.
 */
export async function absorbRateLimit(c: LoopRunContext, err: unknown): Promise<void> {
  const { d } = c

  if (!isGitHubRateLimitError(err)) throw err
  if (c.round !== c.roundAtLastWait) c.rateLimitWaits = 0
  if (c.rateLimitWaits >= MAX_CONSECUTIVE_RATE_LIMIT_WAITS) throw err
  c.roundAtLastWait = c.round
  const reset = d.readRateLimitReset ? await d.readRateLimitReset() : null
  c.lastRateLimitResetEpoch = reset
  await d.sleep(rateLimitWaitMs(reset, d.now()))
  c.rateLimitWaits += 1
}

/**
 * One wait for a rate limit that reached the loop through a red check or
 * a blocked Developer turn, to the reset the caller read — a CI job's own
 * marker, or this host's own budget — never polled. It spends the same
 * budget `absorbRateLimit` does; past it, it throws `RateLimitWaitsSpent`,
 * which ends the round in the no-ruling rate-limit pause.
 */
export async function waitForRateLimitReset(
  c: LoopRunContext,
  resetEpochSeconds: number | null,
  what: string
): Promise<void> {
  const { d, loopLogPath } = c

  if (c.round !== c.roundAtLastWait) c.rateLimitWaits = 0
  if (c.rateLimitWaits >= MAX_CONSECUTIVE_RATE_LIMIT_WAITS) throw new RateLimitWaitsSpent(resetEpochSeconds, what)
  c.roundAtLastWait = c.round
  c.lastRateLimitResetEpoch = resetEpochSeconds
  const waitMs = rateLimitWaitMs(resetEpochSeconds, d.now())
  appendDriverLine(
    loopLogPath,
    `GitHub rate limit in round ${c.round}: ${what} — waiting ${Math.round(waitMs / 1000)}s for the reset`,
    'round'
  )
  await d.sleep(waitMs)
  c.rateLimitWaits += 1
}

/**
 * A red gate whose every failed job is rate-limited (`assessRateLimitedRed`)
 * is waited out, never sent to the Developer: sleep to the reset the
 * jobs' own markers name, rerun the failed jobs, and read the gate again
 * — as often as the rate-limit wait budget allows. Returns the first gate
 * that is not a rate-limited red; it is observed like any other.
 */
export async function absorbRateLimitedRed(
  c: LoopRunContext,
  gate: Awaited<ReturnType<typeof waitForGreenGate>>
): Promise<Awaited<ReturnType<typeof waitForGreenGate>>> {
  const { branch, d } = c

  let current = gate
  while (current.ciConclusion === 'red') {
    const limited = assessRateLimitedRed(current.failureLogs)
    if (limited === null) break
    const head = d.resolveHead(branch)
    await waitForRateLimitReset(c, limited.resetEpochSeconds, `the failed checks on head ${head}`)
    rerunFailedWorkflowsOn(c, head, c.round, 'a rate-limited red gate')
    current = await waitForGreenGate(c, c.roundStartMs, head)
  }
  return current
}

/**
 * Waits out one connection failure to GitHub: checks reachability every
 * `GITHUB_REACHABILITY_INTERVAL_MS`, for as long as it takes, and returns
 * once GitHub answers, so the round re-runs the step that failed. It
 * spends no infrastructure retry and asks for no ruling. A step that
 * keeps failing while GitHub answered the very first check is the step's
 * own failure: past `MAX_ANSWERED_CONNECTION_RETRIES` such re-runs in one
 * round it throws `GitHubKeptAnswering`, an ordinary infrastructure pause.
 */
export async function absorbGitHubOutage(c: LoopRunContext, err: unknown): Promise<void> {
  const { d, loopLogPath } = c

  if (c.round !== c.roundAtLastConnectionRetry) c.answeredConnectionRetries = 0
  c.roundAtLastConnectionRetry = c.round
  const intervalMs = gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_REACHABILITY_POLL_MS', GITHUB_REACHABILITY_INTERVAL_MS)
  appendDriverLine(
    loopLogPath,
    `GitHub could not be reached in round ${c.round} (${(err instanceof Error ? err.message : String(err)).split('\n')[0]}) — waiting for the connection, checking every ${Math.round(intervalMs / 1000)}s`,
    'round'
  )
  let unreachableChecks = 0
  while (true) {
    await d.sleep(intervalMs)
    if (d.isGitHubReachable === undefined || (await d.isGitHubReachable())) break
    unreachableChecks += 1
  }
  if (unreachableChecks === 0) {
    if (c.answeredConnectionRetries >= MAX_ANSWERED_CONNECTION_RETRIES) throw new GitHubKeptAnswering(err)
    c.answeredConnectionRetries += 1
  } else {
    c.answeredConnectionRetries = 0
  }
  appendDriverLine(loopLogPath, `GitHub is reachable again — continuing round ${c.round}`, 'round')
}

/** One read, retried in place across a rate-limit wait — for the reads that follow a role dispatch, where re-entering the round would dispatch it again. */
export async function withRateLimitWait<T>(c: LoopRunContext, read: () => T): Promise<T> {
  while (true) {
    try {
      return read()
    } catch (err) {
      await absorbRateLimit(c, err)
    }
  }
}
