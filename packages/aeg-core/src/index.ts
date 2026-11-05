// The Claude Code collection adapter (`tranche-model.md` §12 layer 2) — one
// host's way to produce a `TranscriptSummary`, exported beside the portable
// renderers it feeds, never as a requirement of the contract.

// The hardened deps every real caller of `resolveMeteringCapability` should
// build from — a sibling module, not part of the pure adapter above.

export { buildProvenanceBlock, hasProvenance, isEligibleForProvenance, taskRefFromBranch } from './archive-task'
export type { MergedPrFacts } from './archive-task'

export {
  assessRound,
  concludedLoopRefusal,
  initialLoopState,
  isConcludedJournal,
  isPublishedSummaryComment,
  nextRoundNumber,
  parseSummaryConfidenceRows,
  PUBLISHED_MARKER_LINE,
  reconstructRounds,
  recordDeveloperAttempt,
  renderPhaseBreakdown,
  renderPublishedMarker,
  renderTaskBudgetDetail,
  taskBudgetExceeded
} from './dev-review-loop'
export type {
  Confidence,
  Decision,
  DevReviewLoopEventInput,
  FindingObservation,
  FindingState,
  Journal,
  LoopConfig,
  LoopState,
  NotReviewedReason,
  Observations,
  PauseReason,
  PendingRound,
  ReconstructedJournal,
  ReconstructionInput,
  ReviewGateFact,
  RoundOutcome,
  RoundRecord,
  RoundStats,
  TaskClock,
  VerdictObservation
} from './dev-review-loop'
