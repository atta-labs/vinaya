import { handoffFindingIds } from './run-state.js'
/**
 * `dev-review-loop`'s CI gate reads: the first-red read, the green-gate wait, the live gate, and the reruns of a
 * failed check or workflow. Moved out of
 * `harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop.ts` verbatim, over the run's
 * `LoopRunContext`; the bodies are unchanged.
 */

import type { RoundStats } from '../../../../tools/dev-review-policy/types'
import { parseLiveTestPlanItems } from '../../../../tools/task-contract/issue-validation'
import { readLiveRecord, withLiveRecord } from '../../../../tools/task-contract/live-record'
import type { DispatchHandle } from '../../dispatch/dispatch.js'
import { appendRoleLine } from '../../../../../../kernel/log/client/loop-log.js'
import { describeFailingCheckRun, type FailingCheckRun } from './gate-reading.js'
import { pollUntil } from './round-assess.js'
import { CI_PARENT_WAIT_POLL_MS, decideStop } from './stop-decision.js'
import { judgeTurnOutput } from './turn-result.js'
import type { FailedCheckLog } from '../../../../../../kernel/tools/failed-check-log.js'
import { readFailedCheckLogs } from '../../run-control/pr-facts.js'
import { type LiveFailure, liveVendorsNamed, livePassedAtHead, runLiveChecks } from './live-check.js'
import { absorbRateLimitedRed } from './rate-limit-waits.js'
import { computeStats } from './round-report.js'
import type { LoopRunContext } from './run-context.js'

/**
 * The first red read of a head goes through the one decision function
 * before any send-back (`decideStop`, kind `ci_red`). A head whose every
 * failing check also fails on the parent's current head waits for the
 * parent, within the row's fixed bound; any other red reruns the head's
 * failed jobs once; a head already rerun is a real failure for the
 * Developer. Every fact is read here from the forge. Returns the gate to
 * judge, and the pause detail when the parent stayed red for the whole
 * bound.
 */
export async function settleFirstRedRead(
  c: LoopRunContext,
  gate: Awaited<ReturnType<typeof waitForGreenGate>>
): Promise<{ gate: Awaited<ReturnType<typeof waitForGreenGate>>; pauseDetail: string | null }> {
  const { d, rerunHeads } = c

  if (gate.ciConclusion !== 'red') return { gate, pauseDetail: null }
  const head = gate.stats.head
  const readParent = (): { failing: string[] | null; conclusion: 'green' | 'red' | 'pending' | null } => {
    try {
      const parentHead = d.resolveHead(d.resolveParentBranch())
      // A parent head equal to the task's own head holds no separate parent to compare with.
      if (parentHead === head) return { failing: null, conclusion: null }
      return {
        failing: d.fetchFailingCheckRuns(parentHead).map((run) => run.name),
        conclusion: d.fetchCiConclusion(parentHead)
      }
    } catch {
      // A parent that cannot be read never decides a wait.
      return { failing: null, conclusion: null }
    }
  }
  const headFailing = gate.failingRuns.map((run) => run.name)
  let parentWaitedMs = 0
  for (;;) {
    const parent = readParent()
    const decided = decideStop({
      kind: 'ci_red',
      runner: 'loop',
      head,
      headFailing,
      rerunHeads: [...rerunHeads],
      parentFailing: parent.failing,
      parentConclusion: parent.conclusion,
      parentWaitedMs
    })
    if (decided.type === 'wait') {
      await d.sleep(CI_PARENT_WAIT_POLL_MS)
      parentWaitedMs += CI_PARENT_WAIT_POLL_MS
      continue
    }
    if (decided.type === 'pause') return { gate, pauseDetail: decided.detail }
    if (decided.type === 'rerun') {
      const rerunIds = rerunFailedWorkflowsOn(c, head, c.round, 'a first red CI read')
      if (rerunIds.length === 0) return { gate, pauseDetail: null }
      rerunHeads.add(head)
      return { gate: await absorbRateLimitedRed(c, await waitForGreenGate(c, c.roundStartMs, head)), pauseDetail: null }
    }
    return { gate, pauseDetail: null }
  }
}

export async function waitForGreenGate(
  c: LoopRunContext,
  roundStartMs: number,
  head: string = c.d.resolveHead(c.branch)
): Promise<{
  green: boolean
  stats: RoundStats
  ciConclusion: 'green' | 'red' | 'pending'
  /** O3: the mechanical check-runs that actually failed, named by check name AND run — never the review gate's own, never a superseded run (`fetchFailingCheckRuns` is already deduped to the newest per name) — empty unless `ciConclusion === 'red'`. */
  failingChecks: string[]
  failingRuns: FailingCheckRun[]
  failureLogs: FailedCheckLog[]
}> {
  const { d } = c

  const conclusion = await pollUntil(
    () => {
      const c = d.fetchCiConclusion(head)
      return c === 'pending' ? null : c
    },
    d.gatePollMaxAttempts,
    d.gatePollIntervalMs,
    d.sleep,
    `devReviewLoop: CI never resolved off 'pending' for head ${head} within the poll budget.`
  ).catch(() => 'red' as const)
  const failingRuns = conclusion === 'red' ? d.fetchFailingCheckRuns(head) : []
  return {
    green: conclusion === 'green',
    stats: computeStats(c, head, roundStartMs),
    ciConclusion: conclusion,
    failingChecks: failingRuns.map(describeFailingCheckRun),
    failingRuns,
    failureLogs: readFailedCheckLogs(
      failingRuns.filter((run) => run.detail === undefined),
      d.readFailedCheckLogTail
    )
  }
}

/**
 * The live check (`harness/processes/vinaya-strict/loops/dev-review/loop.md`, "The live check"): once both
 * reviewers have approved `head` and before the task concludes, every
 * `[live]` line of the frozen brief's Test Plan runs here — from this
 * driver's own process, never the Developer's sandbox — in a fresh
 * checkout of `head` this driver prepares (`prepareLiveCheckout`), never
 * the Developer's worktree, each bounded by `liveRunTimeoutMs`. A line runs the
 * pull request's own code with this host's sign-ins in reach, so it never
 * runs on a head no reviewer approved. Returns the lines that failed (a
 * non-zero exit or a timeout), which the caller sends back as a new round;
 * `[]` when the brief names none, the record already shows each passed at
 * `head`, or every line passed or could not run here.
 *
 * A line naming a vendor this host holds no subscription sign-in for is
 * not run and not failed: it is recorded unverified, which the merge gate
 * holds like an unticked `[principal]` item. Every outcome is written to
 * the pull request's `VINAYA:LIVE` record, keyed by `head`, so a later head
 * runs every line again.
 *
 * The check fails closed. `brief` is the frozen brief the caller already
 * read this round (`withRateLimitWait`) — this check makes no forge read
 * of its own for it, so a read that fails throws at the caller, and a
 * brief whose `[live]` lines cannot be learned throws here: either way
 * the round ends as an infrastructure failure and is retried, never
 * concluded as a pass or a skip. A pull request body that cannot be read
 * holds no earlier entry, so every line runs again; a record that cannot
 * be written is logged, and the next run writes it.
 */
export async function runLiveGate(c: LoopRunContext, head: string, brief: string): Promise<LiveFailure[]> {
  const { d, loopLogPath, repo, root } = c

  let commands: string[]
  try {
    commands = parseLiveTestPlanItems(brief)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    appendRoleLine(
      loopLogPath,
      'dev-review-loop',
      `live_check_failed_closed: the frozen brief's [live] lines could not be read (${reason})`
    )
    throw new Error(`the live check could not read the frozen brief's [live] lines at ${head}: ${reason}`)
  }
  if (commands.length === 0) return []
  let body: string | null
  try {
    body = d.fetchPrBody(c.prNumber)
  } catch {
    body = null
  }
  const previous = body === null ? [] : readLiveRecord(body)
  if (livePassedAtHead(commands, head, previous)) return []
  // A checkout is prepared only when some line can run here; a host
  // signed in to none of the vendors the lines name records them all
  // unverified without one.
  const anyRunnable = commands.some((command) => liveVendorsNamed(command).every(d.liveVendorSignedIn))
  const checkout = anyRunnable ? await d.prepareLiveCheckout(root, head) : null
  let result: Awaited<ReturnType<typeof runLiveChecks>>
  try {
    result = await runLiveChecks({
      commands,
      head,
      cwd: checkout !== null && 'cwd' in checkout ? checkout.cwd : root,
      previous,
      cannotRun:
        checkout !== null && 'error' in checkout
          ? `the review loop could not prepare a clean checkout of this head (${checkout.error})`
          : null,
      signedIn: d.liveVendorSignedIn,
      run: d.runLiveCommand,
      timeoutMs: d.liveRunTimeoutMs
    })
  } finally {
    if (checkout !== null && 'dispose' in checkout) checkout.dispose()
  }
  for (const entry of result.entries) {
    appendRoleLine(loopLogPath, 'dev-review-loop', `live_check: ${entry.outcome} at ${head}: ${entry.command}`)
  }
  try {
    const current = d.fetchPrBody(c.prNumber)
    const next = withLiveRecord(current, result.entries)
    if (next !== current) await d.updatePrBody({ prNumber: c.prNumber, body: next, repo })
  } catch (err) {
    appendRoleLine(
      loopLogPath,
      'dev-review-loop',
      `live_record_update_failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return result.failures
}

/**
 * A `tooling_unavailable` report is settled by the driver when the open
 * pull request's head has failed mechanical check runs: each one's
 * workflow run has its failed jobs rerun through the forge, then the gate
 * is waited for as after any push. `null` — the report pauses as it
 * stands — when the result is another kind, no pull request is open, no
 * failed check run names a workflow run, or the forge refused every rerun.
 */
export async function rerunRedCheckForToolingReport(
  c: LoopRunContext,
  handle: DispatchHandle,
  roundNum: number,
  answersFindings: boolean
): Promise<{ runIds: number[]; ciConclusion: 'green' | 'red' | 'pending'; failingChecks: string[] } | null> {
  const { branch, d } = c

  const verdict = judgeTurnOutput(handle.turnOutput, {
    round: roundNum,
    knownFindingIds: handoffFindingIds(c),
    requireAddressedFindings: answersFindings && handoffFindingIds(c).length > 0,
    documentation: handle.documentation ?? { sources: [], countedReads: [] }
  })
  if (!verdict.ok || verdict.result.status !== 'blocked' || verdict.result.blocker.kind !== 'tooling_unavailable')
    return null
  if (d.findOpenPrForBranch(branch) === null) return null
  let head: string
  try {
    head = d.resolveHead(branch)
  } catch {
    return null
  }
  const rerun = await rerunFailedChecksForHead(c, head, roundNum, 'a tooling_unavailable report')
  if (rerun === null) return null
  return { runIds: rerun.runIds, ciConclusion: rerun.gate.ciConclusion, failingChecks: rerun.gate.failingChecks }
}

/** Rerun every failed workflow on one head, then wait for that head's gate once. */
export async function rerunFailedChecksForHead(
  c: LoopRunContext,
  head: string,
  roundNum: number,
  reason: string
): Promise<{ runIds: number[]; gate: Awaited<ReturnType<typeof waitForGreenGate>> } | null> {
  const { d, rerunHeads } = c

  const rerunIds = rerunFailedWorkflowsOn(c, head, roundNum, reason)
  if (rerunIds.length === 0) return null
  rerunHeads.add(head)
  const gate = await waitForGreenGate(c, d.now())
  return { runIds: rerunIds, gate }
}

/** Rerun the failed jobs of every failed workflow on one head; the run ids the forge accepted. */
export function rerunFailedWorkflowsOn(c: LoopRunContext, head: string, roundNum: number, reason: string): number[] {
  const { d } = c

  const rerunIds: number[] = []
  for (const runId of d.fetchFailedCheckWorkflowRunIds(head)) {
    try {
      d.rerunFailedWorkflowJobs(runId)
      rerunIds.push(runId)
    } catch (err) {
      console.error(
        `vinaya dev-review-loop: could not rerun the failed jobs of workflow run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  if (rerunIds.length > 0)
    console.error(
      `vinaya dev-review-loop: reran the failed jobs of workflow run ${rerunIds.join(', ')} for ${reason} in round ${roundNum}`
    )
  return rerunIds
}
