export * from './types'
export type { StateSource } from './state-source'
export type { DoctrineContent, DoctrineSource } from './doctrine-source'
export { CLI_CHECK_RING, GATE_AUDIENCE, NON_GATE_BINS, SHIPPED_BIN_AUDIENCE, isShipped } from './gate-audience'
export type { GateAudience, InternalGate, ShippedGate } from './gate-audience'
export { ANCHOR_FIELDS, anchoredRegion, anchoredRegionBounds } from './anchored-region'
export type { AnchorField } from './anchored-region'
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
export { formatBreakdown, formatTokenReportRow, formatTokensLine } from './report-tokens'
export type { TokenReportRowInput, TokensLineInput, TranscriptSummary, UsageComponents } from './report-tokens'
// The Claude Code collection adapter (`tranche-model.md` §12 layer 2) — one
// host's way to produce a `TranscriptSummary`, exported beside the portable
// renderers it feeds, never as a requirement of the contract.
export {
  isTokenCollectionWiringBroken,
  resolveMeteringCapability,
  summarizeTranscript
} from './claude-code-transcript'
export type { MeteringCapability, MeteringCapabilityDeps, MeteringIncapableReason } from './claude-code-transcript'
// The hardened deps every real caller of `resolveMeteringCapability` should
// build from (`#313`) — a sibling module, not part of the pure adapter above.
export { hardenedMeteringDeps, isTrustedMeteringStat } from './metering-io-guard'
export { declarationsIn, findCollisions } from './symbol-collisions'
export type { SymbolCollision, SymbolDeclaration } from './symbol-collisions'
export { isCodeFile, isDocFile, isSpecFile } from './file-classify'
export { hasStatusBlock } from './status-block'
export {
  classifyDocOwnersManifest,
  DOC_OWNERS_PATH,
  evaluateC5,
  globToRegex,
  isMechanicallyNeutralDiff,
  isUrlPointer,
  parseDocOwners,
  pointerToPath,
  readDocAcks,
  readDocNeutrals
} from './doc-owners'
export type { C5Result, DocAck, DocNeutral, DocOwnersBinding, DocOwnersManifestState } from './doc-owners'
export {
  isPrincipal,
  isWaiverLabelActorVerified,
  PRINCIPAL_ALLOWLIST,
  WAIVER_LABEL,
  WAIVER_LABEL_REVIEW
} from './waiver-label'
export {
  blockingSeverities,
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewBlockingSeverities,
  DEFAULT_REVIEW_POLICY,
  evaluateCodeReview,
  evaluateReviewFindings,
  evaluateSecurityReview,
  isKnownSeverity,
  isProseLocation,
  SECURITY_SEVERITY_ORDER,
  securityBlockingSeverities
} from './review-policy'
export type {
  CodeReviewSeverity,
  PolicyEvaluation,
  PolicyFinding,
  ReviewPolicy,
  SecuritySeverity
} from './review-policy'
export { deriveSection7, globsOverlap } from './derive-section7'
export type { Section7Match } from './derive-section7'
export { checkManifestValidity, parseNoDocRules } from './manifest-validity'
export type { NoDocRule } from './manifest-validity'
export { evaluateVocabularyCitation } from './vocabulary-citation'
export type {
  VocabularyCheckResult,
  VocabularyFinding,
  VocabularyHit,
  VocabularyPattern
} from './vocabulary-citation'
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
  BriefSectionResult,
  BriefSectionsOptions,
  FencedBlock,
  FrozenBriefCandidate,
  ResolvedFrozenBrief
} from './brief-validation'
export { checkDoctrineNoProcedures } from './doctrine-no-procedures'
export type { DoctrineFile, DoctrineProcedureFinding } from './doctrine-no-procedures'
export { checkDecisionsDensity, checkPrReportDensity, checkScopeDensity } from './pr-report-density'
export type { DensityResult } from './pr-report-density'
export {
  checkA1,
  checkA2,
  checkA3,
  checkClosesNTopology,
  checkD1,
  checkL1,
  checkL2,
  checkL3,
  checkL4,
  checkL5,
  checkR1,
  checkR2,
  checkR3,
  checkT1,
  checkT2,
  checkT3,
  COHERENCE_ENFORCED_FROM,
  extractClosesReferences,
  isGrandfathered,
  R1_GRANDFATHERED_ISSUES,
  scopeT2ToPlanPr
} from './coherence-checks'
export type {
  CheckFailure,
  CheckResult,
  CoherenceFailureCode,
  ForgeIssue,
  TrancheFile,
  TaskEntry
} from './coherence-checks'
export {
  buildProvenanceBlock,
  extractIssue,
  hasProvenance,
  isEligibleForProvenance,
  taskRefFromBranch
} from './archive-task'
export type { MergedPrFacts } from './archive-task'
export { extractCodeReviewVerdict, extractSecurityReviewVerdict, VERDICT_MARKER_SOURCE } from './verdict-extraction'
export type { VerdictExtraction } from './verdict-extraction'
export {
  CHANGESET_RELEASE_BRANCH,
  checkReviewGate,
  DEFAULT_RELEASE_ACTOR,
  isChangesetsReleasePr,
  isReviewGateExemptBranch
} from './review-gate'
export type { ReviewGateComment, ReviewGateInput, ReviewGateResult, ReviewGateVerdict } from './review-gate'
export { newestPrincipalRulingOrdinal } from './ruling-ordinal'
export type { RulingComment } from './ruling-ordinal'
export {
  briefHash,
  buildReviewInputManifest,
  compareManifest,
  isBoundToBriefHash,
  isBoundToHead,
  isBoundToObjectives,
  isBoundToPatch,
  isBoundToPolicy,
  isBoundToRulings,
  manifestAsEchoed,
  policyDigest
} from './review-input-manifest'
export type {
  EchoedManifest,
  ManifestBindingResult,
  ReviewInputManifest,
  ReviewInputManifestFacts
} from './review-input-manifest'
export {
  checkBlastRadiusScope,
  checkConflictCompleteness,
  checkDocsWithinSurface,
  checkIssueBriefSections,
  checkIssueObjectives,
  checkIssueRationale,
  checkIssueType,
  checkMilestoneAttach,
  checkNoBriefContent,
  checkNoForeignTaskOwnership,
  checkObjectivesRespectBoundary,
  checkPartsCiteDefinedObjectives,
  checkPartsCoverageAndSequence,
  checkProjectsRegistered,
  checkRationaleNamesDocs,
  checkRationaleSurfaceCoverage,
  checkSurfaceExcludesBoundDoc,
  checkSurfaceGlobsResolve,
  checkSurfaceOverlap,
  checkTrancheLabelPresence,
  checkSurfaceScope,
  declaredProjects,
  edgesNameEachOther,
  frozenSectionsChanged,
  globCoversPath,
  isTaskIssueBodyShaped,
  isTaskIssueLabelSet,
  BRIEF_SECTIONS_SINCE_ISSUE,
  OBJECTIVES_SINCE_ISSUE,
  parseIssueParts,
  parseIssueStopConditions,
  parseIssueSurface,
  parseIssueTestPlan
} from './issue-validation'
export type {
  FrozenSection,
  IssuePart,
  IssueSectionResult,
  IssueSurface,
  IssueTestPlan,
  SurfaceScopeResult,
  SurfaceScopeViolation,
  ProjectPath,
  TaskIssueFacts,
  TaskSurfaceFacts
} from './issue-validation'
export { findHeadingLine, findTable, rowToRecord } from './markdown-table'
export type { ParsedTable, TableRow } from './markdown-table'
export { deriveDiagramModel } from './diagram-model'
export type {
  DiagramConfig,
  DiagramEdge,
  DiagramFinding,
  DiagramModel,
  DiagramNode,
  DiagramNodeKind,
  RenderState
} from './diagram-model'
export { parseEnforcementRegistry } from './registry-parse'
export type { GateRing, GateRow } from './registry-parse'
export { checkG1, checkG2, checkG3, checkG4, checkG5, checkG6 } from './registry-checks'
export type { RegistryCheckResult, RegistryCheckStatus, RegistryFinding } from './registry-checks'
export { applyScaffoldPlan, computeScaffoldPlan, PLACEHOLDER } from './registry-scaffold'
export type { ScaffoldPlan, ScaffoldSkip, ScaffoldStub } from './registry-scaffold'
export { ACTIONS, CROSSING_KEYWORDS } from './actions'
export type { Action, ActionCrossing } from './actions'
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
export { checkDocClaims } from './doc-claim'
export type { ClaimBinding, ClaimFinding, DocClaimSourceFile } from './doc-claim'
export { classifyLeftover } from './leftover-detection'
export type { LeftoverInput, LeftoverResult, LeftoverVerdict } from './leftover-detection'
export { checkDeadBranchPush } from './dead-branch-push-guard'
export type {
  DeadBranchPushInput,
  DeadBranchPushResult,
  DeadBranchPushVerdict,
  PrStateFact
} from './dead-branch-push-guard'
export { captureBaseline, compareToBaseline } from './baseline-capture'
export type { BaselineComparison, BaselineEntry, BaselineToolComparison } from './baseline-capture'
export { checkDoctrinePortability } from './doctrine-portability'
export type { PortabilityFinding, PortabilitySourceFile } from './doctrine-portability'
export {
  checkReaderResolvableProse,
  checkUndefinedVocabulary,
  checkUnresolvableReferences,
  classifyProseFile,
  legacySlugPattern,
  parseGlossaryTerms,
  PRODUCT_SLUG_SCOPE,
  stripNonProse
} from './reader-resolvable-prose'
export type { ProseFileClass, ProseFinding, ProseSourceFile } from './reader-resolvable-prose'
export {
  checkQuotedCommandStaleness,
  evaluateCitedQuotes,
  findCitedQuotes,
  isValidCitedFilePath
} from './quoted-command'
export type { CitedQuote, QuotedCommandFinding, QuotedCommandSourceFile } from './quoted-command'
export {
  PATTERN_EXEMPT,
  RETIRED_EXEMPT_SUBSTRINGS,
  RETIRED_PATTERNS,
  scanRetiredVocabulary
} from './retired-vocabulary'
export type { VocabFinding, VocabSourceFile } from './retired-vocabulary'
export { checkLocalAnchorCoverage } from './local-anchor-coverage'
export type {
  AnchorCoverageFinding,
  AnchorCoverageScope,
  AnchorSourceFile,
  LocalAnchorCoverageOptions,
  LocalAnchorCoverageResult
} from './local-anchor-coverage'
export { checkDispatchReadiness } from './dispatch-gate'
export type {
  DispatchBlocker,
  DispatchBlockerClass,
  DispatchConflictsWithFact,
  DispatchDependsOnFact,
  DispatchEdgeFact,
  DispatchGateInput,
  DispatchIssueFact,
  DispatchPriorTrancheFact,
  DispatchPriorTaskFact,
  DispatchResult
} from './dispatch-gate'
export { checkSinglePlanPr, trancheSlugFromTopologyPath, touchesAnyTopology } from './single-plan-pr'
export type { OpenPrFiles } from './single-plan-pr'
export { isNewDiskStateFile } from './no-disk-state'
export type { DiskStateFileStatus } from './no-disk-state'
export { checkDirectMainPush } from './direct-main-push'
export type { DirectMainPushFact, DirectMainPushResult } from './direct-main-push'
export { checkMainBranchRefusal } from './main-branch-refusal'
export type { MainBranchRefusalFinding, MainBranchRefusalReason } from './main-branch-refusal'
export { ensureLabelExists, LABEL_COLOR } from './ensure-label'
export type { LabelExistenceIo } from './ensure-label'
export { findDeadBranchPushes } from './dead-branch-push-audit'
export type { DeadBranchFact, DeadBranchPush } from './dead-branch-push-audit'
export { checkBranchTopology, taskBranchTopologyFields } from './branch-topology-gate'
export type { BranchTopologyInput, BranchTopologyResult, BranchTopologyVerdict } from './branch-topology-gate'
export { issueBranchName, parseTaskBranchIdentity } from './task-branch-identity'
export type { TaskBranchIdentity } from './task-branch-identity'
export {
  capabilityUnavailable,
  DEFAULT_PAGE_LIMIT,
  isTaskToolName,
  MAX_PAGE_LIMIT,
  TASK_CANCEL_TOOL,
  TASK_ESCALATION_READ_TOOL,
  TASK_RESUME_TOOL,
  TASK_START_TOOL,
  TASK_STATUS_TOOL,
  TASK_TOOL_CATALOG,
  TASK_TOOL_ERROR_KINDS,
  TASK_TOOL_NAMES,
  taskToolByName,
  taskToolError,
  taskStartRequestIdentity,
  TaskStartResultSchema,
  EscalationEvidenceSchema,
  EscalationInputsSchema,
  FreshnessSchema,
  NoResultSchema,
  ObservedSchema,
  PageRequestSchema,
  RequestedAuthoritySchema,
  TaskCancelInputSchema,
  TaskEscalationPacketSchema,
  TaskEscalationReadInputSchema,
  TaskEscalationReadResultSchema,
  TaskToolRefSchema,
  TaskResumeInputSchema,
  TaskStartInputSchema,
  TaskStatusInputSchema,
  TaskStatusItemSchema,
  TaskStatusResultSchema,
  TaskToolErrorSchema
} from './task-tools'
export type {
  Freshness,
  PageRequest,
  RequestedAuthority,
  TaskCancelInput,
  TaskEscalationPacket,
  TaskEscalationReadInput,
  TaskEscalationReadResult,
  TaskResumeInput,
  TaskStartInput,
  TaskStartRequestInput,
  TaskStartResult,
  TaskStatusInput,
  TaskStatusResult,
  TaskToolDefinition,
  TaskToolError,
  TaskToolErrorKind,
  TaskToolHandlerBinding,
  TaskToolName,
  TaskToolRef
} from './task-tools'
export { checkFirstPushDispatchGate, parseTaskBranch } from './first-push-dispatch-gate'
export type {
  DispatchReadinessFact,
  FirstPushDispatchGateInput,
  FirstPushDispatchGateResult,
  FirstPushDispatchGateVerdict
} from './first-push-dispatch-gate'
export { decideIssueAssignment } from './issue-assignment'
export type { IssueAssignmentDecision, IssueAssignmentInput } from './issue-assignment'
export { locateTestPlanSection } from './test-plan-section'
export type { TestPlanSection } from './test-plan-section'
export { evaluateTestPlanGate } from './test-plan-gate'
export type { TestPlanGateResult, TestPlanGateVerdict } from './test-plan-gate'
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
export { findWorkspaceEscapes } from './workspace-escape'
export type { WorkspaceEscapeFinding, WorkspaceEscapeReason, WorkspaceEscapeSourceFile } from './workspace-escape'
export { extractBoundaryFilePaths, extractSourceRevision, parseRationaleFields, renderBrief } from './brief-render'
export type { BriefFacts, RationaleFieldKey, RenderResult, SurfaceFileFact } from './brief-render'
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
  extractLoopEventsFromCommentBody,
  initialLoopState,
  nextRoundNumber,
  parseLoopEventLines,
  reconstructRounds,
  renderSummary
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
  Observations,
  PauseReason,
  PendingRound,
  ReconstructedJournal,
  RoundOutcome,
  RoundRecord,
  RoundStats,
  VerdictObservation
} from './dev-review-loop'
export {
  buildHeader,
  classifyStoredLine,
  createFixtureStore,
  DispatchEventSchema,
  DevReviewLoopEventSchema,
  EffectEventSchema,
  ForgeOpSchema,
  ForgeWriteEventSchema,
  GateEventSchema,
  GateOutcomeSchema,
  HandoffEventSchema,
  HeaderMetaV1Schema,
  HeaderMetaV2Schema,
  HeaderSchema,
  HostSchema,
  HOST_VALUES,
  InputVersionsSchema,
  KNOWN_SCHEMA_VERSIONS,
  LineageSchema,
  LogEventSchema,
  OperationEventSchema,
  OperationResultSchema,
  ProvenanceSchema,
  readPageFrom,
  recordIdentity,
  redact,
  RoleAttemptEventSchema,
  RoleAttemptOutcomeSchema,
  RoleSchema,
  ROLE_VALUES,
  UsageEventSchema
} from './log'
export type {
  AppendOutcome,
  DispatchEvent,
  DispatchOutcome,
  DevReviewLoopEvent,
  EffectEvent,
  FixtureStoreOptions,
  ForgeOp,
  ForgeWriteEvent,
  GateEvent,
  GateOutcome,
  HandoffEvent,
  Header,
  HeaderInput,
  HeaderMetaV1,
  HeaderMetaV2,
  Host,
  InputVersions,
  Lineage,
  LogEvent,
  LogStore,
  OperationEvent,
  OperationResult,
  OverflowDiagnostic,
  Provenance,
  ReadDiagnostics,
  ReadPage,
  ReadRecord,
  RecordIdentity,
  ReviewFinding,
  Role,
  RoleAttemptEvent,
  RoleAttemptOutcome,
  Subject,
  UsageEvent,
  UsageUnits
} from './log'
export {
  acquireOwnership,
  appendTransition,
  CONTROL_RECORD_VERSION,
  defaultControlStoreDeps,
  defaultIsPidAlive,
  InvalidEffectKeyError,
  InvalidRunIdError,
  migrateLegacyTask,
  normalizeOutcome,
  parseEffectRecord,
  parseInputRecord,
  parseOwnershipRecord,
  parseRunRecord,
  parseTransitionRecord,
  readCurrentOwnership,
  readEffect,
  readInput,
  readRun,
  readTransitions,
  StaleEpochWriteError,
  writeEffect,
  writeInput,
  writeRun
} from './control-store'
export type {
  AcquireResult,
  ControlRecord,
  ControlStoreDeps,
  EffectInput,
  EffectRecord,
  EffectStatus,
  InputInput,
  InputRecord,
  MigrationResult,
  NormalizedOutcome,
  OutcomeSignals,
  OwnershipRecord,
  ParsedRecord,
  RunInput,
  RunRecord,
  TaskOutcomeStatus,
  TransitionInput,
  TransitionRecord
} from './control-store'
