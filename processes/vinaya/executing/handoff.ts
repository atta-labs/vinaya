import type { DevReviewLoopEventInput, EscalationRecord, PauseReason } from '@attalabs/aeg-core'
import {
  bindPauseToPullRequest,
  postIssuePauseComment,
  postPauseComment,
  readPauseState,
  writeEscalationRecord,
  writePauseState,
  type PauseCommentPostResult,
  type PauseState
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import {
  MAX_INFRASTRUCTURE_RETRIES,
  spendsInfrastructureRetry
} from '../../../apps/cli/src/lib/dev-review-loop/round-assess'

// The one place a pause on the Engine path is made durable. Every action whose
// decision is `pause`, and every error that reaches the runner uncaught, comes
// here: the escalation record, then the pause record, then the one pause
// comment, then the run control's halt. The writers are the standalone
// loop's own, imported rather than copied, so a reader of either path finds
// the same records.

/** The input versions an escalation record binds its ruling to. */
export interface InputVersions {
  briefHash: string | null
  objectivesVersion: string | null
  rulingOrdinal: number
  policyDigest: string
}

/** What the handoff needs to know about the run it pauses. */
export interface HandoffRun {
  task: number
  branch: string
  /** Where run files go; the pause record lives under it. */
  runtimeDir: string
  runId: string
  agent: string
  model?: string
  /** The review round the run is in now. */
  round: () => number
  /** The head the run's work stands at now. */
  head: () => string
  /** The pull request open for the branch, or null while none is. */
  prNumber: () => number | null
  /** The input versions read when the pause is raised; may throw, in which case no escalation record is written. */
  versions: () => InputVersions
  /** Halts the run through its run control. */
  halt: (reason: string) => void
}

/** The functions the handoff calls; a run that must not reach the forge replaces them. */
export interface HandoffDeps {
  writeEscalationRecord: typeof writeEscalationRecord
  writePauseState: typeof writePauseState
  readPauseState: typeof readPauseState
  postPauseComment: typeof postPauseComment
  postIssuePauseComment: typeof postIssuePauseComment
  bindPauseToPullRequest: typeof bindPauseToPullRequest
  /** Writes one Log event. */
  log: (event: DevReviewLoopEventInput) => void
}

export const liveHandoffDeps = (log: HandoffDeps['log']): HandoffDeps => ({
  writeEscalationRecord,
  writePauseState,
  readPauseState,
  postPauseComment,
  postIssuePauseComment,
  bindPauseToPullRequest,
  log
})

export interface PauseRequest {
  reason: PauseReason
  detail: string
  /** The error behind an infrastructure pause; whether it spends the retry budget is read from it. */
  error?: unknown
  /** The Developer's evidence the escalation record carries. */
  evidence?: string
}

export interface HandoffResult {
  /** The escalation record's own id; absent when no record could be written. */
  escalationId?: string
  /** Whether the pause comment landed. */
  commentPosted: boolean
  /** The infrastructure retries this task has spent, this pause included. */
  infrastructureRetries: number
  /** True once the budget is spent: the pause no longer grants a bare, ruling-free resume. */
  retryBudgetSpent: boolean
  /** True when this call found the run already handed off and wrote nothing. */
  repeated: boolean
}

export interface Handoff {
  /** Makes the pause durable, tells the forge once and halts the run. Never throws. */
  pause: (request: PauseRequest) => HandoffResult
  /**
   * Binds a pause raised before any pull request existed to `pr`, the open pull
   * request on the run's own branch. Returns the bound record, or null when no
   * such pause is held.
   */
  bindToPullRequest: (pr: number) => PauseState | null
}

/** The Log event for a pause comment that took more than one attempt or never landed; null for the ordinary first-try post. */
export function commentRetryEvent(
  loopId: string,
  round: number,
  result: PauseCommentPostResult
): DevReviewLoopEventInput | null {
  if (result.posted && result.attempts <= 1) return null
  return {
    kind: 'dev_review_loop',
    payload: {},
    loop_id: loopId,
    event: 'infrastructure_retry',
    round,
    failure_kind: 'pause_comment_post',
    attempts: result.attempts,
    outcome: result.posted ? 'recovered' : 'exhausted'
  } as DevReviewLoopEventInput
}

export function createHandoff(run: HandoffRun, loopId: string, deps: HandoffDeps): Handoff {
  let done: HandoffResult | null = null
  return {
    pause: (request) => {
      if (done !== null) return { ...done, repeated: true }
      const round = run.round()
      const head = run.head()
      const pr = run.prNumber()
      // The budget a prior pause already spent is read back, so it carries across runs.
      const prior = deps.readPauseState(run.runtimeDir, run.task)?.infrastructureRetries ?? 0
      const infrastructureRetries =
        request.reason === 'infrastructure' && request.error !== undefined && spendsInfrastructureRetry(request.error)
          ? prior + 1
          : prior
      let escalation: EscalationRecord | null = null
      let rulingOrdinal: number | undefined
      // The records come first, escalation then pause, before anything is posted.
      // The escalation record is best-effort: the pause record is what a resume needs.
      try {
        const versions = run.versions()
        rulingOrdinal = versions.rulingOrdinal
        escalation = deps.writeEscalationRecord({
          task: run.task,
          round,
          head,
          branch: run.branch,
          pr,
          runId: run.runId,
          agent: run.agent,
          reason: request.reason,
          detail: request.detail,
          evidence: request.evidence,
          ...versions
        })
      } catch {}
      let commentPosted = false
      try {
        deps.writePauseState(run.runtimeDir, {
          task: run.task,
          round,
          head,
          branch: run.branch,
          prNumber: pr,
          reason: request.reason,
          detail: request.detail,
          pausedAt: new Date().toISOString(),
          agent: run.agent,
          ...(run.model ? { model: run.model } : {}),
          escalationId: escalation?.escalationId,
          infrastructureRetries
        })
        const invocation = { agent: run.agent, ...(run.model ? { model: run.model } : {}) }
        const posted =
          pr === null
            ? deps.postIssuePauseComment(
                run.task,
                run.branch,
                round,
                request.reason,
                request.detail,
                invocation,
                escalation?.rulingOrdinal ?? rulingOrdinal
              )
            : deps.postPauseComment(run.task, round, head, pr, request.reason, request.detail, invocation)
        commentPosted = posted.posted
        const retried = commentRetryEvent(loopId, round, posted)
        if (retried !== null) deps.log(retried)
      } catch {
        // The pause record is authoritative; a failed write or post never undoes the halt.
      }
      done = {
        ...(escalation ? { escalationId: escalation.escalationId } : {}),
        commentPosted,
        infrastructureRetries,
        retryBudgetSpent: infrastructureRetries >= MAX_INFRASTRUCTURE_RETRIES,
        repeated: false
      }
      run.halt(request.reason)
      return done
    },
    bindToPullRequest: (pr) => {
      const held = deps.readPauseState(run.runtimeDir, run.task)
      if (held === null || held.prNumber !== null || held.branch !== run.branch) return null
      return deps.bindPauseToPullRequest(run.runtimeDir, held, pr)
    }
  }
}
