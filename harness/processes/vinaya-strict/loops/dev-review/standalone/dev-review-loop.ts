/** The standalone review-loop orchestrator and compatibility exports. */
import { markProcessUnattended } from '../../../../../kernel/run-paths.js'
import { createLoopRunContext } from './dev-review-loop/run-context.js'
import { defaultDeps } from './dev-review-loop/runtime-defaults.js'
import { setStandaloneLogIdentity } from './dev-review-loop/driver-helpers.js'
import { initializeRunEntry, finishRun } from './dev-review-loop/run-entry.js'
import { initializeRunBody } from './dev-review-loop/run-setup.js'
import { startRun } from './dev-review-loop/run-start.js'
import { keepDriverLock } from './dev-review-loop/driver-lifecycle.js'
import type { LoopDeps } from './dev-review-loop/driver-deps.js'
import type { LoopInput, LoopResult } from './dev-review-loop/driver-helpers.js'

export {
  describeFailingCheckRun,
  fetchCiConclusion,
  fetchConflictingFiles,
  fetchFailingCheckRuns,
  fetchMergeableState,
  gitCommitsTouchingDriverPaths,
  readWorktreeHead,
  resolveHead
} from './dev-review-loop/gate-reading.js'
export type { MergeableState, PrOpenState } from './dev-review-loop/gate-reading.js'
export { DRIVER_OWNED_PATHS, fetchPrState, parseMergeTreeConflictFiles } from './dev-review-loop/gate-reading.js'
export {
  checkTaskDispatchReadiness,
  describeObjectivesEdit,
  developerBranchFor,
  DeveloperStopSignal,
  extractObjectivesSection,
  fetchDeveloperStop,
  fetchFrozenBrief,
  fetchIssueRulings,
  fetchIssueTitle,
  fetchNewestIssueRulingAuthor,
  fetchNewestIssueRulingOrdinal,
  fetchNewestRulingAuthor,
  fetchNewestRulingOrdinal,
  fetchRulings,
  fetchSourceRevision,
  filterDeveloperStops,
  filterPrincipalRulings,
  findLatestPrincipalObjectivesEdit,
  findOpenPrForBranch,
  findPrincipalFrozenBrief,
  NO_SOURCE_REVISION,
  parseObjectivesEditComment,
  resolveIssueObjectives,
  reviewPolicy,
  reviewPolicyForLoop,
  taskFromPrBody
} from './dev-review-loop/developer-dispatch.js'
export type {
  DispatchReadinessCheckResult,
  MarkerComment,
  ObjectivesEditParse,
  ObjectivesEditSource,
  ObjectivesResolution
} from './dev-review-loop/developer-dispatch.js'
export {
  lintReviewerPrompt,
  reclassifyProseOnlyNotMet,
  runtimeDir,
  renderReviewerPrompt,
  ReviewerInfrastructureFailure,
  ReviewerResultRejected,
  writeHeldVerdict
} from './dev-review-loop/reviewer-dispatch.js'
export type { ReviewerPromptFacts } from './dev-review-loop/reviewer-dispatch.js'
export { publishRound } from './dev-review-loop/publication.js'
export type { PublishInput } from './dev-review-loop/publication.js'
export {
  escalationIdFor,
  fenceStartedEffectsAsUncertain,
  noPushResumeCommandFor,
  readEscalationRecord,
  readResolutionRecord,
  renderNoPushStopComment,
  renderPauseComment,
  ReplayedResolutionError,
  resolveEscalation,
  StaleEscalationError,
  writeEscalationRecord,
  WrongTargetResolutionError
} from './dev-review-loop/pause-resume.js'
export type { EscalationFacts, ResolveEscalationResult } from './dev-review-loop/pause-resume.js'
export {
  developerRoundMarker,
  DevReviewLoopResumeError,
  DispatchSandboxRefused,
  DispatchSignInRefused,
  renderDeveloperRoundComment,
  routeCompletionEvents,
  spendsInfrastructureRetry
} from './dev-review-loop/round-assess.js'
export {
  DeveloperTurnResultPause,
  judgeTurnOutput,
  PERMISSIBLE_RULING_DECISIONS,
  readTurnResultRecords,
  turnResultInstruction
} from './dev-review-loop/turn-result.js'
export { pushedCommitRangeBase } from '../actions/live-developer-context.js'
export type { LoopDeps } from './dev-review-loop/driver-deps.js'
export { defaultRunSecurityScanSubprocess } from './dev-review-loop/git-defaults.js'
export { defaultPatchIdOf } from './dev-review-loop/git-defaults.js'
export { assertValidLoopEvent } from './dev-review-loop/git-defaults.js'
export { defaultGitWorktreeChangedPaths } from './dev-review-loop/git-defaults.js'
export { defaultGitWorktreeUntrackedPaths } from './dev-review-loop/git-defaults.js'
export type { MergedDefaultCommit } from './dev-review-loop/git-defaults.js'
export { defaultReadMergedDefaultCommit } from './dev-review-loop/git-defaults.js'
export { defaultReadDefaultBranchTip } from './dev-review-loop/git-defaults.js'
export type { DefaultTipClassification } from './dev-review-loop/git-defaults.js'
export { defaultClassifyAgainstDefaultTip } from './dev-review-loop/git-defaults.js'
export type { RebaseOntoTipResult } from './dev-review-loop/git-defaults.js'
export type { MergeDefaultTipResult } from './dev-review-loop/git-defaults.js'
export { defaultMergeDefaultTip } from './dev-review-loop/git-defaults.js'
export { defaultRebaseOntoDefaultTip } from './dev-review-loop/git-defaults.js'
export { defaultRestoreWorktreeHead } from './dev-review-loop/git-defaults.js'
export { ownChangesRangeBase } from './dev-review-loop/git-defaults.js'
export { handoffFindings } from './dev-review-loop/developer-defaults.js'
export { developerContinuationFacts } from './dev-review-loop/developer-defaults.js'
export { worktreeInstallEnv } from './dev-review-loop/developer-defaults.js'
export { defaultInstallWorktreeDependencies } from './dev-review-loop/developer-defaults.js'
export { boundedPushOutput } from './dev-review-loop/developer-defaults.js'
export { pushBranchClassified } from './dev-review-loop/developer-defaults.js'
export { defaultUpdatePrBody } from './dev-review-loop/developer-defaults.js'
export { failedCheckLogsOnHead } from './dev-review-loop/developer-defaults.js'
export { renderFailedCheckLog } from './dev-review-loop/developer-defaults.js'
export { failureSignaturePart } from './dev-review-loop/developer-defaults.js'
export { projectPrChecks } from './dev-review-loop/developer-defaults.js'
export { projectPrReviews } from './dev-review-loop/developer-defaults.js'
export { worktreeCheckEnv } from './dev-review-loop/developer-defaults.js'
export { defaultRunWorktreeChecks } from './dev-review-loop/developer-defaults.js'
export { prReportRefreshArgs } from './dev-review-loop/developer-defaults.js'
export { describeConfidencePauseDetail } from './dev-review-loop/runtime-defaults.js'
export { deriveVerdictPauseDetail } from './dev-review-loop/runtime-defaults.js'
export { sanitizeUncaughtErrorForPublicPause } from './dev-review-loop/runtime-defaults.js'
export { defaultDeps } from './dev-review-loop/runtime-defaults.js'
export { deferredEntriesForRound } from './dev-review-loop/driver-helpers.js'
export type { LoopInput } from './dev-review-loop/driver-helpers.js'
export type { LoopResult } from './dev-review-loop/driver-helpers.js'
export { buildReexecArgs } from './dev-review-loop/driver-helpers.js'
export { surfaceOpenedAgentConfigPaths } from './dev-review-loop/driver-helpers.js'
export { publishingInstructionLine } from './dev-review-loop/driver-helpers.js'
export { setStandaloneLogIdentity } from './dev-review-loop/driver-helpers.js'
export type { CancelInput } from './dev-review-loop/cancel.js'
export type { CancelResult } from './dev-review-loop/cancel.js'
export type { CancelDeps } from './dev-review-loop/cancel.js'
export { cancelDevReviewLoop } from './dev-review-loop/cancel.js'
export type { DriverEndReason } from './dev-review-loop/driver-watch.js'
export type { DriverDecision } from './dev-review-loop/driver-watch.js'
export type { DriverResult } from './dev-review-loop/driver-watch.js'
export type { DriverWatchDeps } from './dev-review-loop/driver-watch.js'
export type { DriverCarry } from './dev-review-loop/driver-watch.js'
export { driverCarryArgs } from './dev-review-loop/driver-watch.js'
export { runDriverLoop } from './dev-review-loop/driver-watch.js'
export { DEV_REVIEW_LOOP_AGENTS } from './dev-review-loop/driver-watch.js'

export async function devReviewLoop(input: LoopInput, deps: Partial<LoopDeps> = {}): Promise<LoopResult> {
  markProcessUnattended()
  await setStandaloneLogIdentity()
  const d: LoopDeps = { ...defaultDeps(), ...deps }
  const root = d.runtimeDir()
  const c = createLoopRunContext({ d, input, root })
  await initializeRunEntry(c)
  try {
    const outcome = await runDevReviewLoopBody()
    if (
      outcome.finalDecision.type === 'publish' &&
      keepDriverLock({ kind: 'publish', watched: input.retainDriverLock !== undefined && outcome.prNumber > 0 })
    )
      c.keepLockAlive = true
    return outcome
  } finally {
    await finishRun(c)
  }
  async function runDevReviewLoopBody(): Promise<LoopResult> {
    await initializeRunBody(c)
    return startRun(c)
  }
}
