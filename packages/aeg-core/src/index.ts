export * from './types'
export type { StateSource } from './state-source'

export { parseRegistry } from './parse-registry'
export {
  CROSS_CUTTING_CANDIDATES,
  deriveBuiltinCrossCuttingDefaults,
  deriveWorkspacePackageDomains,
  parsePnpmWorkspaceYaml,
  resolveWorkspaceEntry
} from './blast-radius-domains'
export { buildConsumersOf, deriveWorkspaceMemberDirs } from './consumer-enumeration'
export type { PackageManifest } from './consumer-enumeration'
export { parseTranche } from './parse-tranche'
export { deriveTranche } from './derive-tranche'
export { parseLedger, rowFromCells } from './parse-ledger'
export { sumLedger } from './sum-ledger'
export { aggregateTaskTokenRows, parseTokenReportEntries, parseTokensLines } from './parse-token-report'
export type { TokenSourcePr } from './parse-token-report'
export { deriveReviewStatus, parseDeveloperRoundMarker, renderReviewStatus } from './review-status'
export type { ReviewStatus, ReviewStatusInput } from './review-status'
export {
  activeBudgetMs,
  emptyPhaseSamples,
  INACTIVE_BUDGET_PHASES,
  isActiveBudgetPhase,
  isRecordedLoopPhase,
  medianOf,
  MIN_PHASE_HISTORY_SAMPLES,
  phaseHistoryClassFor,
  phaseSamplesFromPrComments,
  summarizePhaseSamples,
  TASK_PHASE_LABELS,
  taskPhaseLabel
} from './task-phase-history'
export type {
  HistoryComment,
  PhaseHistoryClass,
  PhaseSamples,
  RecordedLoopPhase,
  TaskPhaseLabel
} from './task-phase-history'
export { formatBreakdown, formatTokenReportRow, formatTokensLine } from './report-tokens'
export type { TokenReportRowInput, TokensLineInput } from './report-tokens'
// The Claude Code collection adapter (`tranche-model.md` §12 layer 2) — one
// host's way to produce a `TranscriptSummary`, exported beside the portable
// renderers it feeds, never as a requirement of the contract.

// The hardened deps every real caller of `resolveMeteringCapability` should
// build from — a sibling module, not part of the pure adapter above.

export {
  isPrincipal,
  isWaiverLabelActorVerified,
  WAIVER_LABEL,
  WAIVER_LABEL_REVIEW
} from './waiver-label'
export {
  blockingSeverities,
  classifyFinding,
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewBlockingSeverities,
  consequentialFindings,
  DEFAULT_READY_PUSH_TIMEOUT_MINUTES,
  DEFAULT_REVIEW_POLICY,
  DEFERRAL_REASON_TEXT,
  evaluateCodeReview,
  evaluateReviewFindings,
  evaluateSecurityReview,
  isConsequentialFinding,
  isKnownSeverity,
  isProseLocation,
  PROSE_CAP_SEVERITY,
  SECURITY_SEVERITY_ORDER,
  securityBlockingSeverities
} from './review-policy'
export type {
  CodeReviewSeverity,
  DeferralReason,
  DeferredFinding,
  FindingClassification,
  FindingDeferralContext,
  FindingPolicyOutcome,
  PolicyEvaluation,
  PolicyFinding,
  ReviewPolicy,
  SecuritySeverity
} from './review-policy'
export { deriveSection7, globsOverlap } from './derive-section7'
export type { Section7Match } from './derive-section7'
export { deriveTierFromDiff, overrideActive, readTierFromPrBody, TIER_FIELD } from './pr-tier'
export {
  checkAutonomyClause,
  checkBriefSections,
  checkClosesNPresence as checkBriefClosesN,
  checkCommandsCarryOutput,
  checkConsumerTests,
  checkDefeatCases,
  checkDocUpdateList,
  checkForField,
  checkForgeTitle,
  checkNoAgentBoxes,
  checkNoUnpinnedCodeClaims,
  checkObjectivesCopy,
  checkObjectivesCoverage,
  checkPlanPrNoCloses,
  checkPremiseCoverage,
  checkPrincipalPlaceholder,
  checkProjectField,
  checkStopConditions,
  checkSurfaceMap,
  checkTestPlan,
  checkTestPlanExclusivity,
  checkTierField,
  checkWorktreeStep0,
  packagesNamedIn,
  AEG_BRIEF_V1_MARKER,
  AGENT_BOXES_REFUSED_SINCE_PR,
  briefMarkerFor,
  BRIEF_RULES_SINCE_PR,
  COMMAND_WORDS,
  COMMIT_TYPE_STYLE,
  COMMIT_TYPES,
  contentAfterNLines,
  contentAfterTwoLines,
  extractFencedBlocks,
  frozenBriefContent,
  headerRegion,
  inferBranchFromBody,
  isBriefShaped,
  isGrandfatherableBriefRuleError,
  isTaskBranch,
  parseBriefMarkerVersion,
  partitionBriefErrorsByRollout,
  PART_CITATION_RE,
  resolveNewestFrozenBrief
} from './brief-validation'
export type {
  BriefRolloutCutovers,
  BriefSectionResult,
  BriefSectionsOptions,
  FencedBlock,
  FrozenBriefCandidate,
  ResolvedFrozenBrief
} from './brief-validation'
export { checkDecisionsDensity, checkPrReportDensity, checkScopeDensity } from './pr-report-density'
export type { DensityResult } from './pr-report-density'
export { buildProvenanceBlock, hasProvenance, isEligibleForProvenance, taskRefFromBranch } from './archive-task'
export type { MergedPrFacts } from './archive-task'
export {
  extractCodeReviewVerdict,
  extractPauseBoundRuling,
  extractSecurityReviewVerdict,
  parseFindingState,
  VERDICT_MARKER_SOURCE
} from './verdict-extraction'
export type { VerdictExtraction } from './verdict-extraction'
export {
  newestPrincipalRulingAuthor,
  newestPrincipalRulingOrdinal,
  parseRulingIdentity,
  principalRulingMarker,
  principalRulingTextById
} from './ruling-ordinal'
export type { RulingComment } from './ruling-ordinal'
export {
  briefHash,
  buildReviewInputManifest,
  compareManifest,
  isBoundToBase,
  isBoundToBriefHash,
  isBoundToHead,
  isBoundToObjectives,
  isBoundToPatch,
  isBoundToPolicy,
  isBoundToRulings,
  manifestAsEchoed,
  pauseBoundRulingDigest,
  pauseBoundRulingFromResolution,
  policyDigest
} from './review-input-manifest'
export type {
  ConsumedResolution,
  EchoedManifest,
  ManifestBindingResult,
  PauseBoundRuling,
  ReviewInputManifest,
  ReviewInputManifestFacts
} from './review-input-manifest'
export {
  boundaryPinnedFiles,
  checkBlastRadiusScope,
  checkBoundaryClaimsNeedPremise,
  checkConflictCompleteness,
  checkDocsWithinSurface,
  checkFileCollisions,
  DEFAULT_COLLISION_THRESHOLD,
  checkDocumentationCitesObjective,
  checkEdgeIdsWholeNumbers,
  checkIssueBriefSections,
  checkIssueObjectives,
  checkIssuePremises,
  checkIssueRationale,
  type IssueRationaleOptions,
  checkIssueType,
  checkIntroducedCommandsCovered,
  checkIntroducedConfigKeysCovered,
  checkMilestoneAttach,
  checkNoBriefContent,
  checkNoForeignTaskOwnership,
  checkProseAllowsBeyondSurfaceEdit,
  checkCrossTaskValuesPinned,
  checkObjectivesRespectBoundary,
  checkPartsCiteDefinedObjectives,
  checkPartsCoverageAndSequence,
  checkPinnedFileImportersCovered,
  decidePinnedFileImporters,
  checkPinnedFileChecksDecided,
  decidePinnedFileChecks,
  surfaceForcedSet,
  checkNewTestFilesCoverShards,
  checkNewLoopFilesCoverInvariantMap,
  checkDocumentationReadable,
  checkDocumentationPathsExist,
  isNonPublicHost,
  documentationUrls,
  type DocumentationProbe,
  checkPremiseDependencyDeclared,
  checkPremisesHold,
  checkProjectsRegistered,
  checkRationaleNamesDocs,
  checkRationaleSurfaceCoverage,
  checkSurfaceExcludesBoundDoc,
  checkSurfaceGlobsResolve,
  surfaceEntryResolves,
  checkSurfaceOverlap,
  checkTestPlanDeveloperRunnable,
  checkSurfaceScope,
  beyondSurfacePaths,
  recordedBeyondSurfacePaths,
  renderBeyondSurfaceBlock,
  withBeyondSurfaceBlock,
  declaredProjects,
  edgesNameEachOther,
  frozenSectionsChanged,
  globCoversPath,
  isTaskIssueBodyShaped,
  isTaskIssueLabelSet,
  BRIEF_SECTIONS_SINCE_ISSUE,
  DOCUMENTATION_SINCE_ISSUE,
  OBJECTIVES_SINCE_ISSUE,
  parseIssueParts,
  parseIssuePremises,
  parseIssueStopConditions,
  parseIssueSurface,
  parseIssueTestPlan,
  parseLiveTestPlanItems
} from './issue-validation'
export type {
  CommandReferenceEntry,
  CommandReferenceFacts,
  ConfigReferenceFacts,
  FileCollisionResult,
  FrozenSection,
  IssuePart,
  IssuePremise,
  IssueSectionResult,
  IssueSurface,
  IssueTestPlan,
  PinnedFileImporters,
  PinnedFileCheck,
  PinnedFileChecks,
  PinnedCheckDecision,
  PinnedFileCheckDecisions,
  PinnedImporterDecision,
  PinnedFileDecisions,
  SurfaceForcedSet,
  ForcedCompanion,
  BeyondSurfacePath,
  SurfaceScopeResult,
  ProtectedPathViolation,
  ProjectPath,
  TaskFileFacts,
  TaskIssueFacts,
  TaskSurfaceFacts
} from './issue-validation'

export {
  DERIVABLE_STATUSES,
  DERIVATION_RULES,
  DERIVED_STATUSES,
  deriveStatusFromModel,
  FORGE_FACT_INPUTS
} from './state-machine-model'
export type { DerivationRule, ForgeFactInput } from './state-machine-model'
export { checkPremises, parsePremiseBlock } from './premise-check'
export type { PremiseAssertion, PremiseCheckResult } from './premise-check'

export { issueBranchName, parseTaskBranchIdentity } from './task-branch-identity'
export type { TaskBranchIdentity } from './task-branch-identity'

export { locateTestPlanSection } from './test-plan-section'
export type { TestPlanSection } from './test-plan-section'
export {
  carryLiveRecord,
  type LiveRecordEntry,
  type LiveRecordLine,
  readLiveRecord,
  renderLiveRecordBlock,
  renderLiveRecordLine,
  withLiveRecord
} from './live-record'
export {
  AEG_BLOCKED_LABEL,
  buildBranchName,
  fetchForgeFacts,
  fetchForgeTasksByLabel,
  fetchOpenIssuesByLabel,
  fetchTaskIssueRefs,
  findTrancheSlug,
  hasLabel,
  trancheLabel,
  trancheSlugLengthError,
  trancheSlugOf,
  LABEL_MAX_LENGTH,
  LABEL_NAMESPACE,
  LABELS,
  label,
  mapForgeFacts,
  matchesLabel,
  projectsFromBody
} from '@attalabs/aeg-forge-state'
export type { Label, LabelCategory, LabelForm, LabelKey } from '@attalabs/aeg-forge-state'
export type {
  FetchForgeFactsInput,
  ForgeFactsSnapshot,
  PrRef,
  RawTaskFacts,
  TaskIssueRef,
  TaskRef
} from '@attalabs/aeg-types'
export { checkAdoptable, checkMilestoneShape, releaseFieldFromBody } from './milestone-validation'
export type {
  AdoptFacts,
  AdoptResult,
  AdoptSlugFacts,
  AdoptTargetFacts,
  MilestoneIntent,
  MilestoneShapeResult,
  ReleaseField
} from './milestone-validation'

export { extractBoundaryFilePaths, extractSourceRevision, parseRationaleFields, renderBrief } from './brief-render'
export type { BriefFacts, LocalGateCommands, RationaleFieldKey, RenderResult, SurfaceFileFact } from './brief-render'
export { NO_GATE_CUTOVERS } from './gate-cutovers'
export type { GateCutovers } from './gate-cutovers'
export {
  hasObjectivesHeading,
  isIssueNotFoundError,
  objectivesSectionBounds,
  objectivesVersion,
  objectivesOf,
  renderObjectives,
  resolveObjectivesSource
} from './objectives'
export type { Objective, ObjectivesSource, ParsedObjectives } from './objectives'
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

export { isProtectedAdminPath, PROTECTED_ADMIN_PATHS } from './protected-paths'
