import type { LoopRunContext } from './run-context.js'
import type { DispatchHandle } from '../../dispatch/dispatch.js'
import { judgeTurnOutput } from './turn-result.js'
import { handoffFindingIds } from './run-state.js'
import { pauseForAcceptedResult } from './turn-result.js'

import { readFailedCheckLogs } from '../../run-control/pr-facts.js'

import { assessRateLimitedRed } from './round-assess.js'
import { waitForRateLimitReset } from './rate-limit-waits.js'
import { rerunFailedWorkflowsOn } from './ci-gate.js'
import { waitForGreenGate } from './ci-gate.js'
import type { TurnResultControllerContext } from './turn-result.js'
import { worktreePathForBranch } from './developer-prompts.js'
import { existsSync } from 'node:fs'

import { writeTurnResultRecord } from './turn-result.js'
import { schemaValidTurnResult } from './turn-result.js'
import type { DeveloperTurnResult } from '../../../../executing/developer/developer-turn-result.js'

import { DeveloperTurnResultPause } from './turn-result.js'
import { noPushPauseDetail } from './unpushed-work.js'
import { nextTurnResultAttempt } from './turn-result.js'
import { dispatchDeveloperOnce } from './developer-turn.js'
import { turnResultCorrectionPrompt } from './turn-result.js'

import { checkTurnConfinement } from './turn-confinement.js'
import { developerScanTexts } from './turn-confinement.js'
import { describeTurnConfinementViolation } from './turn-confinement.js'

/** Whether the turn's accepted result is `blocked` with reason `test_failure`. */
export function reportsTestFailure(
  c: LoopRunContext,
  handle: DispatchHandle,
  roundNum: number,
  answersFindings: boolean
): boolean {
  const verdict = judgeTurnOutput(handle.turnOutput, {
    round: roundNum,
    knownFindingIds: handoffFindingIds(c),
    requireAddressedFindings: answersFindings && handoffFindingIds(c).length > 0,
    documentation: handle.documentation ?? { sources: [], countedReads: [] }
  })
  return verdict.ok && verdict.result.status === 'blocked' && verdict.result.blocker.kind === 'test_failure'
}

/** Whether the turn ended with an accepted `blocked` or `needs_ruling` result — read before the publication check so the round pauses for the Principal instead of re-asking to publish. */
export function endsInEscalation(
  c: LoopRunContext,
  handle: DispatchHandle,
  roundNum: number,
  answersFindings: boolean
): boolean {
  const verdict = judgeTurnOutput(handle.turnOutput, {
    round: roundNum,
    knownFindingIds: handoffFindingIds(c),
    requireAddressedFindings: answersFindings && handoffFindingIds(c).length > 0,
    documentation: handle.documentation ?? { sources: [], countedReads: [] }
  })
  return verdict.ok && pauseForAcceptedResult(verdict.result) !== null
}

/**
 * A `tooling_unavailable` report made while a GitHub rate limit is spent
 * is waited out by the driver. When the open pull request's head has
 * failed jobs that are all rate-limited (`assessRateLimitedRed`), the
 * driver sleeps to the reset their own markers name — CI's token, never
 * this host's — then reruns them and waits for the gate. Otherwise, when
 * this host's own budget is spent (`readRateLimitReset`), it sleeps to
 * that budget's reset. Each wait spends the loop's rate-limit wait
 * budget. `null` — the report goes on as before — when the result is
 * another kind or neither budget is spent.
 */
export async function waitOutRateLimitForToolingReport(
  c: LoopRunContext,
  handle: DispatchHandle,
  roundNum: number,
  answersFindings: boolean
): Promise<{ kind: 'checks'; runIds: number[]; ciConclusion: 'green' | 'red' | 'pending' } | { kind: 'host' } | null> {
  const { d, branch } = c

  const verdict = judgeTurnOutput(handle.turnOutput, {
    round: roundNum,
    knownFindingIds: handoffFindingIds(c),
    requireAddressedFindings: answersFindings && handoffFindingIds(c).length > 0,
    documentation: handle.documentation ?? { sources: [], countedReads: [] }
  })
  if (!verdict.ok || verdict.result.status !== 'blocked' || verdict.result.blocker.kind !== 'tooling_unavailable')
    return null
  let head: string | null = null
  if (d.findOpenPrForBranch(branch) !== null) {
    try {
      head = d.resolveHead(branch)
    } catch {
      head = null
    }
  }
  if (head !== null) {
    const failureLogs = readFailedCheckLogs(
      d.fetchFailingCheckRuns(head).filter((run) => run.detail === undefined),
      d.readFailedCheckLogTail
    )
    const limited = assessRateLimitedRed(failureLogs)
    if (limited !== null) {
      await waitForRateLimitReset(c, limited.resetEpochSeconds, `the failed checks on head ${head}`)
      const runIds = rerunFailedWorkflowsOn(c, head, roundNum, 'a tooling_unavailable report during a rate limit')
      const gate = await waitForGreenGate(c, d.now(), head)
      return { kind: 'checks', runIds, ciConclusion: gate.ciConclusion }
    }
  }
  const hostReset = d.readRateLimitReset ? await d.readRateLimitReset() : null
  if (hostReset === null) return null
  await waitForRateLimitReset(c, hostReset, "this host's GitHub token")
  return { kind: 'host' }
}

/**
 * O3: the controller — the one place a Developer turn result is
 * accepted. Bound to this run, round, the worktree head the turn left and
 * an attempt ordinal only the driver assigns; judged against this turn's
 * own context (`judgeTurnOutput`); recorded once, accepted or rejected,
 * and never rewritten. A rejected first result is never read by the
 * confidence, review or transition logic: the SAME session is resumed once
 * with only the typed failures and the current context, publishing
 * nothing, and its result is rebound to the head then current — a head
 * that moved since makes it stale — and judged again. A second failure
 * pauses the round with a typed reason. An accepted `blocked` or
 * `needs_ruling` result pauses it for the Principal.
 */
export async function settleTurnResult(
  c: LoopRunContext,
  handle: DispatchHandle,
  roundNum: number,
  answersFindings: boolean
): Promise<void> {
  const { d, root, task, runId, branch, dispatchAgent } = c

  const knownFindingIds = handoffFindingIds(c)
  const context = (documentation: DispatchHandle['documentation']): TurnResultControllerContext => ({
    round: roundNum,
    knownFindingIds,
    requireAddressedFindings: answersFindings && knownFindingIds.length > 0,
    documentation: documentation ?? { sources: [], countedReads: [] }
  })
  const worktreeHead = (): string | null => {
    const dir = worktreePathForBranch(c)
    return existsSync(dir) ? d.readWorktreeHead(dir) : null
  }
  const record = (
    attempt: number,
    head: string | null,
    verdict: ReturnType<typeof judgeTurnOutput>,
    raw: unknown
  ): void => {
    writeTurnResultRecord(root, task, {
      version: 1,
      runId: runId,
      round: roundNum,
      attempt,
      head,
      outcome: verdict.ok ? 'accepted' : 'rejected',
      result: verdict.ok
        ? verdict.result
        : schemaValidTurnResult(raw, {
            knownFindingIds,
            requiredSources: context(handle.documentation).documentation.sources
          }),
      failures: verdict.ok ? [] : verdict.failures,
      recordedAt: new Date(d.now()).toISOString()
    })
  }
  const accept = (result: DeveloperTurnResult): void => {
    const pause = pauseForAcceptedResult(result)
    if (pause === null) return
    // The work the turn left unpublished is kept; the pause names it so
    // the ruling can say what to do with it.
    const dir = worktreePathForBranch(c)
    const unpushed = existsSync(dir) ? d.readUnpushedWorkDetail(dir) : { dirtyFiles: [], aheadCount: 0 }
    if (unpushed.dirtyFiles.length === 0 && unpushed.aheadCount === 0) throw pause
    throw new DeveloperTurnResultPause(
      pause.kind,
      `${pause.message} — work left unpublished, kept as it is: ${noPushPauseDetail(branch, unpushed)}`
    )
  }

  const firstAttempt = nextTurnResultAttempt(root, task, roundNum)
  const firstHead = worktreeHead()
  const first = judgeTurnOutput(handle.turnOutput, context(handle.documentation))
  record(firstAttempt, firstHead, first, handle.turnOutput?.raw)
  if (first.ok) return accept(first.result)
  if (handle.turnOutput === undefined || handle.turnOutput.adapter === null) {
    throw new DeveloperTurnResultPause(
      'no_adapter',
      `the Developer turn delivered no structured turn result — ${dispatchAgent} offers no native structured output this loop can read (round ${roundNum}, attempt ${firstAttempt})`
    )
  }

  const correction = await dispatchDeveloperOnce(
    c,
    turnResultCorrectionPrompt(first.failures, {
      round: roundNum,
      attempt: firstAttempt,
      head: firstHead,
      knownFindingIds
    }),
    roundNum,
    {}
  )
  const secondAttempt = firstAttempt + 1
  const secondHead = worktreeHead()
  if (correction.failureReason) {
    record(
      secondAttempt,
      secondHead,
      { ok: false, failures: [`turnResult: the correction turn failed (${correction.failureReason})`] },
      null
    )
    throw new DeveloperTurnResultPause(
      'rejected',
      `the Developer's turn result was rejected (${first.failures.join('; ')}) and the one correction turn failed (${correction.failureReason})`
    )
  }
  const correctionConfinement = checkTurnConfinement(c, 'developer', developerScanTexts(c, correction))
  const second: ReturnType<typeof judgeTurnOutput> =
    correctionConfinement.changedPaths.length > 0 || correctionConfinement.credentialFindings.length > 0
      ? {
          ok: false,
          failures: [
            `turnResult: the correction turn changed the worktree — ${describeTurnConfinementViolation(c, correctionConfinement)}`
          ]
        }
      : secondHead !== firstHead
        ? {
            ok: false,
            failures: [
              `turnResult: stale — the head moved from ${firstHead} to ${secondHead} during the correction turn`
            ]
          }
        : judgeTurnOutput(correction.turnOutput, context(correction.documentation))
  record(secondAttempt, secondHead, second, correction.turnOutput?.raw)
  if (second.ok) return accept(second.result)
  throw new DeveloperTurnResultPause(
    secondHead !== firstHead ? 'stale' : 'rejected',
    `the Developer's turn result was rejected twice in round ${roundNum} (attempt ${firstAttempt}: ${first.failures.join('; ')}; attempt ${secondAttempt}: ${second.failures.join('; ')})`
  )
}
