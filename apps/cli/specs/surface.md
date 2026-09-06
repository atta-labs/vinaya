# Surface — the public function index

Status: draft

One command is one function, published and tested. `apps/cli/tests/surface-index.test.ts` enforces every table below against the real source tree; this file is its source of truth, not the reverse.

## The rule

A command is a function with argument parsing in front. Commands never call commands. One capability is one function.

Three layers:

- **Policy** — `@attalabs/aeg-core`. Pure functions: no filesystem, no network, no process. Read here, never written by this task.
- **Effects** — `apps/cli/src/lib`. The chokepoints that touch the world: git, the filesystem, the forge, a child process. A future consolidated set (`log`, `flushLog`, `forgeWrite`, `forgeRead`, `runChecks`, `collectTokens`, `dispatchRole`, `devReviewLoop`, `runTask` — Tech Spec "A Task Finishes Itself" §2–§3) does not fully exist yet; today's `apps/cli/src/lib` is a wider micro-library commands compose directly.
- **Commands** — `apps/cli/src/commands`. One file per command (or per closely-related command family sharing a file, e.g. `milestone.ts`). Each command's entry function, reached from `apps/cli/src/index.ts`'s router, should call exactly one effects-layer function. `apps/cli/src/index.ts` itself is the router, not a command, and is exempt by construction.

**Predicate the test enforces (per Principal ruling on Issue #418):** for a command's entry function, collect every call expression (transitively through same-file helpers) whose callee resolves to an export of `apps/cli/src/lib/**` or of another `apps/cli/src/commands/*.ts` file. A call into `apps/cli/src/lib` beyond the one named function is a violation. A call into another `commands/*.ts` file is refused outright — commands never call commands — with zero allowance beyond the same dated-exemption mechanism (no separate carve-out). `printJson`, `promptYesNo`/`closeStdin`, and `packageRoot` count toward the cap like any other call — no allowlist (see Open note below). Calls into `@attalabs/aeg-core` are unrestricted (policy is meant to be composed freely).

**Open note (Principal ruling, 2026-09-05):** `printJson`, `promptYesNo`/`closeStdin`, and `packageRoot` are called by most commands purely for output/prompt/path-resolution plumbing, not business effect. They are not allowlisted out of the cap — they count like any other call — but the shape that will retire most of today's exemptions for install/scaffolding commands (`doctor`, `doctrine`, `eject`, `init`, `init product`, `quickstart`, `upgrade`, `demo break`, `waiver`, `brief render`) is a **shared command shell** consolidating this plumbing, not one of the six chokepoints below. That shell is a later task, named here as `sharedCommandShell` in the Exemptions table until it exists.

## Policy — `@attalabs/aeg-core` public exports

Every non-type export of the package barrel (`packages/aeg-core/src/index.ts`), read for this index, unrestricted for commands to call.

| Export | Kind | Declared in |
|---|---|---|
| `ACTIONS` | const | `packages/aeg-core/src/actions.ts` |
| `CROSSING_KEYWORDS` | const | `packages/aeg-core/src/actions.ts` |
| `ANCHOR_FIELDS` | const | `packages/aeg-core/src/anchored-region.ts` |
| `anchoredRegion` | function | `packages/aeg-core/src/anchored-region.ts` |
| `anchoredRegionBounds` | function | `packages/aeg-core/src/anchored-region.ts` |
| `buildProvenanceBlock` | function | `packages/aeg-core/src/archive-task.ts` |
| `extractIssue` | function | `packages/aeg-core/src/archive-task.ts` |
| `hasProvenance` | function | `packages/aeg-core/src/archive-task.ts` |
| `isEligibleForProvenance` | function | `packages/aeg-core/src/archive-task.ts` |
| `taskRefFromBranch` | function | `packages/aeg-core/src/archive-task.ts` |
| `captureBaseline` | function | `packages/aeg-core/src/baseline-capture.ts` |
| `compareToBaseline` | function | `packages/aeg-core/src/baseline-capture.ts` |
| `CROSS_CUTTING_CANDIDATES` | const | `packages/aeg-core/src/blast-radius-domains.ts` |
| `deriveBuiltinCrossCuttingDefaults` | function | `packages/aeg-core/src/blast-radius-domains.ts` |
| `deriveWorkspacePackageDomains` | function | `packages/aeg-core/src/blast-radius-domains.ts` |
| `parsePnpmWorkspaceYaml` | function | `packages/aeg-core/src/blast-radius-domains.ts` |
| `resolveWorkspaceEntry` | function | `packages/aeg-core/src/blast-radius-domains.ts` |
| `checkBranchTopology` | function | `packages/aeg-core/src/branch-topology-gate.ts` |
| `taskBranchTopologyFields` | function | `packages/aeg-core/src/branch-topology-gate.ts` |
| `parseRationaleFields` | function | `packages/aeg-core/src/brief-render.ts` |
| `renderBrief` | function | `packages/aeg-core/src/brief-render.ts` |
| `AGENT_BOXES_REFUSED_SINCE_PR` | const | `packages/aeg-core/src/brief-validation.ts` |
| `BRIEF_RULES_SINCE_PR` | const | `packages/aeg-core/src/brief-validation.ts` |
| `checkAutonomyClause` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkBriefClosesN` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkBriefSections` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkCommandsCarryOutput` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkConsumerTests` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkDefeatCases` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkDocUpdateList` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkForField` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkForgeTitle` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkNoAgentBoxes` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkNoUnpinnedCodeClaims` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkPlanPrNoCloses` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkPremiseCoverage` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkPrincipalPlaceholder` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkProjectField` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkStopConditions` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkSurfaceMap` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkTestPlan` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkTestPlanExclusivity` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkTierField` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkWorktreeStep0` | function | `packages/aeg-core/src/brief-validation.ts` |
| `COMMAND_WORDS` | const | `packages/aeg-core/src/brief-validation.ts` |
| `COMMIT_TYPE_STYLE` | const | `packages/aeg-core/src/brief-validation.ts` |
| `COMMIT_TYPES` | const | `packages/aeg-core/src/brief-validation.ts` |
| `extractFencedBlocks` | function | `packages/aeg-core/src/brief-validation.ts` |
| `headerRegion` | function | `packages/aeg-core/src/brief-validation.ts` |
| `inferBranchFromBody` | function | `packages/aeg-core/src/brief-validation.ts` |
| `isBriefShaped` | function | `packages/aeg-core/src/brief-validation.ts` |
| `isGrandfatherableBriefRuleError` | function | `packages/aeg-core/src/brief-validation.ts` |
| `isTaskBranch` | function | `packages/aeg-core/src/brief-validation.ts` |
| `partitionBriefErrorsByRollout` | function | `packages/aeg-core/src/brief-validation.ts` |
| `isTokenCollectionWiringBroken` | function | `packages/aeg-core/src/claude-code-transcript.ts` |
| `resolveMeteringCapability` | function | `packages/aeg-core/src/claude-code-transcript.ts` |
| `summarizeTranscript` | function | `packages/aeg-core/src/claude-code-transcript.ts` |
| `checkA1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkA2` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkA3` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkClosesN` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkD1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL2` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL3` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL4` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL5` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkR1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkT1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkT2` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkT3` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `COHERENCE_ENFORCED_FROM` | const | `packages/aeg-core/src/coherence-checks.ts` |
| `extractClosesReferences` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `isGrandfathered` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `R1_GRANDFATHERED_ISSUES` | const | `packages/aeg-core/src/coherence-checks.ts` |
| `scopeT2ToPlanPr` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `buildConsumersOf` | function | `packages/aeg-core/src/consumer-enumeration.ts` |
| `deriveWorkspaceMemberDirs` | function | `packages/aeg-core/src/consumer-enumeration.ts` |
| `findDeadBranchPushes` | function | `packages/aeg-core/src/dead-branch-push-audit.ts` |
| `checkDeadBranchPush` | function | `packages/aeg-core/src/dead-branch-push-guard.ts` |
| `deriveSection7` | function | `packages/aeg-core/src/derive-section7.ts` |
| `globsOverlap` | function | `packages/aeg-core/src/derive-section7.ts` |
| `deriveTranche` | function | `packages/aeg-core/src/derive-tranche.ts` |
| `deriveDiagramModel` | function | `packages/aeg-core/src/diagram-model.ts` |
| `checkDirectMainPush` | function | `packages/aeg-core/src/direct-main-push.ts` |
| `checkDispatchReadiness` | function | `packages/aeg-core/src/dispatch-gate.ts` |
| `classifyDocOwnersManifest` | function | `packages/aeg-core/src/doc-owners.ts` |
| `DOC_OWNERS_PATH` | const | `packages/aeg-core/src/doc-owners.ts` |
| `evaluateC5` | function | `packages/aeg-core/src/doc-owners.ts` |
| `globToRegex` | function | `packages/aeg-core/src/doc-owners.ts` |
| `isMechanicallyNeutralDiff` | function | `packages/aeg-core/src/doc-owners.ts` |
| `isUrlPointer` | function | `packages/aeg-core/src/doc-owners.ts` |
| `parseDocOwners` | function | `packages/aeg-core/src/doc-owners.ts` |
| `pointerToPath` | function | `packages/aeg-core/src/doc-owners.ts` |
| `readDocAcks` | function | `packages/aeg-core/src/doc-owners.ts` |
| `readDocNeutrals` | function | `packages/aeg-core/src/doc-owners.ts` |
| `checkDoctrineNoProcedures` | function | `packages/aeg-core/src/doctrine-no-procedures.ts` |
| `checkDoctrinePortability` | function | `packages/aeg-core/src/doctrine-portability.ts` |
| `ensureLabelExists` | function | `packages/aeg-core/src/ensure-label.ts` |
| `LABEL_COLOR` | const | `packages/aeg-core/src/ensure-label.ts` |
| `isCodeFile` | function | `packages/aeg-core/src/file-classify.ts` |
| `isDocFile` | function | `packages/aeg-core/src/file-classify.ts` |
| `isSpecFile` | function | `packages/aeg-core/src/file-classify.ts` |
| `checkFirstPushDispatchGate` | function | `packages/aeg-core/src/first-push-dispatch-gate.ts` |
| `parseTaskBranch` | function | `packages/aeg-core/src/first-push-dispatch-gate.ts` |
| `CLI_CHECK_RING` | const | `packages/aeg-core/src/gate-audience.ts` |
| `GATE_AUDIENCE` | const | `packages/aeg-core/src/gate-audience.ts` |
| `isShipped` | function | `packages/aeg-core/src/gate-audience.ts` |
| `NON_GATE_BINS` | const | `packages/aeg-core/src/gate-audience.ts` |
| `SHIPPED_BIN_AUDIENCE` | const | `packages/aeg-core/src/gate-audience.ts` |
| `decideIssueAssignment` | function | `packages/aeg-core/src/issue-assignment.ts` |
| `checkBlastRadiusScope` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkConflictCompleteness` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkIssueRationale` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkIssueType` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkNoBriefContent` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkProjectsRegistered` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkRationaleNamesDocs` | function | `packages/aeg-core/src/issue-validation.ts` |
| `declaredProjects` | function | `packages/aeg-core/src/issue-validation.ts` |
| `isTaskIssueLabelSet` | function | `packages/aeg-core/src/issue-validation.ts` |
| `classifyLeftover` | function | `packages/aeg-core/src/leftover-detection.ts` |
| `checkLocalAnchorCoverage` | function | `packages/aeg-core/src/local-anchor-coverage.ts` |
| `buildHeader` | function | `packages/aeg-core/src/log/envelope.ts` |
| `redact` | function | `packages/aeg-core/src/log/redact.ts` |
| `ROLE_VALUES` | const | `packages/aeg-core/src/log/schema.ts` |
| `RoleSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `HOST_VALUES` | const | `packages/aeg-core/src/log/schema.ts` |
| `HostSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `HeaderSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `DispatchEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `DevReviewLoopEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `LogEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `checkMainBranchRefusal` | function | `packages/aeg-core/src/main-branch-refusal.ts` |
| `checkManifestValidity` | function | `packages/aeg-core/src/manifest-validity.ts` |
| `parseNoDocRules` | function | `packages/aeg-core/src/manifest-validity.ts` |
| `findHeadingLine` | function | `packages/aeg-core/src/markdown-table.ts` |
| `findTable` | function | `packages/aeg-core/src/markdown-table.ts` |
| `rowToRecord` | function | `packages/aeg-core/src/markdown-table.ts` |
| `hardenedMeteringDeps` | function | `packages/aeg-core/src/metering-io-guard.ts` |
| `isTrustedMeteringStat` | function | `packages/aeg-core/src/metering-io-guard.ts` |
| `checkAdoptable` | function | `packages/aeg-core/src/milestone-validation.ts` |
| `checkMilestoneShape` | function | `packages/aeg-core/src/milestone-validation.ts` |
| `releaseFieldFromBody` | function | `packages/aeg-core/src/milestone-validation.ts` |
| `isNewDiskStateFile` | function | `packages/aeg-core/src/no-disk-state.ts` |
| `parseLedger` | function | `packages/aeg-core/src/parse-ledger.ts` |
| `rowFromCells` | function | `packages/aeg-core/src/parse-ledger.ts` |
| `parseRegistry` | function | `packages/aeg-core/src/parse-registry.ts` |
| `aggregateTaskTokenRows` | function | `packages/aeg-core/src/parse-token-report.ts` |
| `parseTokenReportEntries` | function | `packages/aeg-core/src/parse-token-report.ts` |
| `parseTokensLines` | function | `packages/aeg-core/src/parse-token-report.ts` |
| `parseTranche` | function | `packages/aeg-core/src/parse-tranche.ts` |
| `checkPrReportDensity` | function | `packages/aeg-core/src/pr-report-density.ts` |
| `checkScopeDensity` | function | `packages/aeg-core/src/pr-report-density.ts` |
| `checkSummaryDensity` | function | `packages/aeg-core/src/pr-report-density.ts` |
| `deriveTierFromDiff` | function | `packages/aeg-core/src/pr-tier.ts` |
| `overrideActive` | function | `packages/aeg-core/src/pr-tier.ts` |
| `readTierFromPrBody` | function | `packages/aeg-core/src/pr-tier.ts` |
| `TIER_FIELD` | const | `packages/aeg-core/src/pr-tier.ts` |
| `checkPremises` | function | `packages/aeg-core/src/premise-check.ts` |
| `parsePremiseBlock` | function | `packages/aeg-core/src/premise-check.ts` |
| `checkQuotedCommandStaleness` | function | `packages/aeg-core/src/quoted-command.ts` |
| `evaluateCitedQuotes` | function | `packages/aeg-core/src/quoted-command.ts` |
| `findCitedQuotes` | function | `packages/aeg-core/src/quoted-command.ts` |
| `isValidCitedFilePath` | function | `packages/aeg-core/src/quoted-command.ts` |
| `checkReaderResolvableProse` | function | `packages/aeg-core/src/reader-resolvable-prose.ts` |
| `checkUndefinedVocabulary` | function | `packages/aeg-core/src/reader-resolvable-prose.ts` |
| `checkUnresolvableReferences` | function | `packages/aeg-core/src/reader-resolvable-prose.ts` |
| `classifyProseFile` | function | `packages/aeg-core/src/reader-resolvable-prose.ts` |
| `legacySlugPattern` | function | `packages/aeg-core/src/reader-resolvable-prose.ts` |
| `parseGlossaryTerms` | function | `packages/aeg-core/src/reader-resolvable-prose.ts` |
| `stripNonProse` | function | `packages/aeg-core/src/reader-resolvable-prose.ts` |
| `checkG1` | function | `packages/aeg-core/src/registry-checks.ts` |
| `checkG2` | function | `packages/aeg-core/src/registry-checks.ts` |
| `checkG3` | function | `packages/aeg-core/src/registry-checks.ts` |
| `checkG4` | function | `packages/aeg-core/src/registry-checks.ts` |
| `checkG5` | function | `packages/aeg-core/src/registry-checks.ts` |
| `checkG6` | function | `packages/aeg-core/src/registry-checks.ts` |
| `parseEnforcementRegistry` | function | `packages/aeg-core/src/registry-parse.ts` |
| `applyScaffoldPlan` | function | `packages/aeg-core/src/registry-scaffold.ts` |
| `computeScaffoldPlan` | function | `packages/aeg-core/src/registry-scaffold.ts` |
| `PLACEHOLDER` | const | `packages/aeg-core/src/registry-scaffold.ts` |
| `formatBreakdown` | function | `packages/aeg-core/src/report-tokens.ts` |
| `formatTokenReportRow` | function | `packages/aeg-core/src/report-tokens.ts` |
| `formatTokensLine` | function | `packages/aeg-core/src/report-tokens.ts` |
| `PATTERN_EXEMPT` | const | `packages/aeg-core/src/retired-vocabulary.ts` |
| `RETIRED_EXEMPT_SUBSTRINGS` | const | `packages/aeg-core/src/retired-vocabulary.ts` |
| `RETIRED_PATTERNS` | const | `packages/aeg-core/src/retired-vocabulary.ts` |
| `scanRetiredVocabulary` | function | `packages/aeg-core/src/retired-vocabulary.ts` |
| `CHANGESET_RELEASE_BRANCH` | const | `packages/aeg-core/src/review-gate.ts` |
| `checkReviewGate` | function | `packages/aeg-core/src/review-gate.ts` |
| `DEFAULT_RELEASE_ACTOR` | const | `packages/aeg-core/src/review-gate.ts` |
| `isChangesetsReleasePr` | function | `packages/aeg-core/src/review-gate.ts` |
| `isReviewGateExemptBranch` | function | `packages/aeg-core/src/review-gate.ts` |
| `deriveReviewStatus` | function | `packages/aeg-core/src/review-status.ts` |
| `parseDeveloperRoundMarker` | function | `packages/aeg-core/src/review-status.ts` |
| `renderReviewStatus` | function | `packages/aeg-core/src/review-status.ts` |
| `checkSinglePlanPr` | function | `packages/aeg-core/src/single-plan-pr.ts` |
| `touchesAnyTopology` | function | `packages/aeg-core/src/single-plan-pr.ts` |
| `trancheSlugFromTopologyPath` | function | `packages/aeg-core/src/single-plan-pr.ts` |
| `DERIVABLE_STATUSES` | const | `packages/aeg-core/src/state-machine-model.ts` |
| `DERIVATION_RULES` | const | `packages/aeg-core/src/state-machine-model.ts` |
| `DERIVED_STATUSES` | const | `packages/aeg-core/src/state-machine-model.ts` |
| `deriveStatusFromModel` | function | `packages/aeg-core/src/state-machine-model.ts` |
| `FORGE_FACT_INPUTS` | const | `packages/aeg-core/src/state-machine-model.ts` |
| `hasStatusBlock` | function | `packages/aeg-core/src/status-block.ts` |
| `sumLedger` | function | `packages/aeg-core/src/sum-ledger.ts` |
| `declarationsIn` | function | `packages/aeg-core/src/symbol-collisions.ts` |
| `findCollisions` | function | `packages/aeg-core/src/symbol-collisions.ts` |
| `evaluateTestPlanGate` | function | `packages/aeg-core/src/test-plan-gate.ts` |
| `locateTestPlanSection` | function | `packages/aeg-core/src/test-plan-section.ts` |
| `extractCodeReviewVerdict` | function | `packages/aeg-core/src/verdict-extraction.ts` |
| `extractSecurityReviewVerdict` | function | `packages/aeg-core/src/verdict-extraction.ts` |
| `evaluateVocabularyCitation` | function | `packages/aeg-core/src/vocabulary-citation.ts` |
| `isPrincipal` | function | `packages/aeg-core/src/waiver-label.ts` |
| `isWaiverLabelActorVerified` | function | `packages/aeg-core/src/waiver-label.ts` |
| `PRINCIPAL_ALLOWLIST` | const | `packages/aeg-core/src/waiver-label.ts` |
| `WAIVER_LABEL` | const | `packages/aeg-core/src/waiver-label.ts` |
| `WAIVER_LABEL_REVIEW` | const | `packages/aeg-core/src/waiver-label.ts` |
| `findWorkspaceEscapes` | function | `packages/aeg-core/src/workspace-escape.ts` |
| `buildBranchName` | function | `packages/aeg-forge-state/src/fetch-forge-facts.ts` |
| `fetchForgeFacts` | function | `packages/aeg-forge-state/src/fetch-forge-facts.ts` |
| `fetchForgeTasksByLabel` | function | `packages/aeg-forge-state/src/fetch-forge-facts.ts` |
| `fetchOpenIssuesByLabel` | function | `packages/aeg-forge-state/src/fetch-open-issues.ts` |
| `fetchTaskIssueRefs` | function | `packages/aeg-forge-state/src/fetch-task-issue-refs.ts` |
| `AEG_BLOCKED_LABEL` | const | `packages/aeg-forge-state/src/labels.ts` |
| `findTrancheSlug` | function | `packages/aeg-forge-state/src/labels.ts` |
| `hasLabel` | function | `packages/aeg-forge-state/src/labels.ts` |
| `label` | function | `packages/aeg-forge-state/src/labels.ts` |
| `LABEL_MAX_LENGTH` | const | `packages/aeg-forge-state/src/labels.ts` |
| `LABEL_NAMESPACE` | const | `packages/aeg-forge-state/src/labels.ts` |
| `LABELS` | const | `packages/aeg-forge-state/src/labels.ts` |
| `matchesLabel` | function | `packages/aeg-forge-state/src/labels.ts` |
| `trancheLabel` | function | `packages/aeg-forge-state/src/labels.ts` |
| `trancheSlugLengthError` | function | `packages/aeg-forge-state/src/labels.ts` |
| `trancheSlugOf` | function | `packages/aeg-forge-state/src/labels.ts` |
| `projectsFromBody` | function | `packages/aeg-forge-state/src/list-tasks.ts` |
| `mapForgeFacts` | function | `packages/aeg-forge-state/src/map-forge-facts.ts` |

(237 exports.)

## Effects — `apps/cli/src/lib` public exports

Every exported function/const/class from each file under `apps/cli/src/lib/`. These are the chokepoints a command is allowed to call **one** of.

| Export | Kind | Declared in |
|---|---|---|
| `AGENT_VENDORS` | const | `apps/cli/src/lib/agent-vendors.ts` |
| `isAgentVendor` | function | `apps/cli/src/lib/agent-vendors.ts` |
| `AGENTS_SKILLS_GROUP` | const | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `agentSkillPath` | function | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `buildAgentsSkillsOps` | function | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `discoverRoleNames` | function | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `formatRoleTitle` | function | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `renderAgentSkill` | function | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `ARCHIVIST_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `BODY_CHECKS_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `buildInitOps` | function | `apps/cli/src/lib/artifacts.ts` |
| `CHECKS_FOLDER_PLACEHOLDER_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `CHECKS_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `CONFIG_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `DOCTRINE_POINTER_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `doctrinePointer` | function | `apps/cli/src/lib/artifacts.ts` |
| `labelOps` | function | `apps/cli/src/lib/artifacts.ts` |
| `REVIEW_RETRIGGER_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `REVIEW_VERDICT_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `REVIEW_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `ROLES_FOLDER_PLACEHOLDER_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `SETUP_BUN_SHA` | const | `apps/cli/src/lib/artifacts.ts` |
| `starterConfig` | function | `apps/cli/src/lib/artifacts.ts` |
| `TRACKED_HOOK_DIR` | const | `apps/cli/src/lib/artifacts.ts` |
| `buildClaudeCommandOps` | function | `apps/cli/src/lib/claude-command-emitter.ts` |
| `CLAUDE_COMMAND_GROUP` | const | `apps/cli/src/lib/claude-command-emitter.ts` |
| `CLAUDE_COMMAND_PATH` | const | `apps/cli/src/lib/claude-command-emitter.ts` |
| `renderClaudeCommand` | function | `apps/cli/src/lib/claude-command-emitter.ts` |
| `buildClaudeStopHookOps` | function | `apps/cli/src/lib/claude-stop-hook-emitter.ts` |
| `CLAUDE_SETTINGS_PATH` | const | `apps/cli/src/lib/claude-stop-hook-emitter.ts` |
| `CLAUDE_STOP_HOOK_GROUP` | const | `apps/cli/src/lib/claude-stop-hook-emitter.ts` |
| `CLAUDE_STOP_HOOK_MARKER` | const | `apps/cli/src/lib/claude-stop-hook-emitter.ts` |
| `CLAUDE_STOP_HOOK_SCRIPT_PATH` | const | `apps/cli/src/lib/claude-stop-hook-emitter.ts` |
| `renderClaudeSettingsWithStopHook` | function | `apps/cli/src/lib/claude-stop-hook-emitter.ts` |
| `renderTrackTranscriptScriptBody` | function | `apps/cli/src/lib/claude-stop-hook-emitter.ts` |
| `BRIEF_BUILTINS` | const | `apps/cli/src/lib/config.ts` |
| `configPath` | function | `apps/cli/src/lib/config.ts` |
| `getTokensCollectTrust` | function | `apps/cli/src/lib/config.ts` |
| `gitBlobHash` | function | `apps/cli/src/lib/config.ts` |
| `gitCommonDir` | function | `apps/cli/src/lib/config.ts` |
| `globalChecksIgnoredWarning` | function | `apps/cli/src/lib/config.ts` |
| `globalPrincipalsIgnoredWarning` | function | `apps/cli/src/lib/config.ts` |
| `globalReleaseActorIgnoredWarning` | function | `apps/cli/src/lib/config.ts` |
| `globalRolesIgnoredWarning` | function | `apps/cli/src/lib/config.ts` |
| `globalTokensCollectIgnoredWarning` | function | `apps/cli/src/lib/config.ts` |
| `isCanonicalHookBlockPath` | function | `apps/cli/src/lib/config.ts` |
| `isDefaultedAgentVendorPath` | function | `apps/cli/src/lib/config.ts` |
| `isSafeRepoRelPath` | function | `apps/cli/src/lib/config.ts` |
| `lintEnvDeclarations` | function | `apps/cli/src/lib/config.ts` |
| `loadConfig` | function | `apps/cli/src/lib/config.ts` |
| `loadConfigChecked` | function | `apps/cli/src/lib/config.ts` |
| `loadTrustAnchorConfig` | function | `apps/cli/src/lib/config.ts` |
| `MANAGED_MANIFEST_VERSION` | const | `apps/cli/src/lib/config.ts` |
| `parseTokensCollectDeclaration` | function | `apps/cli/src/lib/config.ts` |
| `readRepoCiSetup` | function | `apps/cli/src/lib/config.ts` |
| `repoLocalConfigDir` | function | `apps/cli/src/lib/config.ts` |
| `resolveAgentVendors` | function | `apps/cli/src/lib/config.ts` |
| `resolvePrincipalAllowlist` | function | `apps/cli/src/lib/config.ts` |
| `resolveReleaseActor` | function | `apps/cli/src/lib/config.ts` |
| `tokensCollectTrustKey` | function | `apps/cli/src/lib/config.ts` |
| `trustAnchorRepo` | function | `apps/cli/src/lib/config.ts` |
| `trustTokensCollectCommand` | function | `apps/cli/src/lib/config.ts` |
| `VinayaConfigSchema` | const | `apps/cli/src/lib/config.ts` |
| `writeConfig` | function | `apps/cli/src/lib/config.ts` |
| `activeRawHooks` | function | `apps/cli/src/lib/detect.ts` |
| `branchProtectionConfigured` | function | `apps/cli/src/lib/detect.ts` |
| `checkGhAuth` | function | `apps/cli/src/lib/detect.ts` |
| `classifyBranchProtectionError` | function | `apps/cli/src/lib/detect.ts` |
| `customHooksPath` | function | `apps/cli/src/lib/detect.ts` |
| `detectGitRepo` | function | `apps/cli/src/lib/detect.ts` |
| `foreignRawHooks` | function | `apps/cli/src/lib/detect.ts` |
| `ghAuthStatus` | function | `apps/cli/src/lib/detect.ts` |
| `ghLabelGateway` | function | `apps/cli/src/lib/detect.ts` |
| `hookDirFromManifest` | function | `apps/cli/src/lib/detect.ts` |
| `readCoreHooksPath` | function | `apps/cli/src/lib/detect.ts` |
| `resolveHookDir` | function | `apps/cli/src/lib/detect.ts` |
| `setCoreHooksPath` | function | `apps/cli/src/lib/detect.ts` |
| `unsetCoreHooksPath` | function | `apps/cli/src/lib/detect.ts` |
| `changedLineRanges` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `fileDiffAgainst` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `findingsInThisDiff` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `lineIsInRanges` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `repoRoot` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `resolveChangedFiles` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `resolveDiff` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `appendDocOwnersBinding` | function | `apps/cli/src/lib/doc-owners-write.ts` |
| `applyDocOwnersBinding` | function | `apps/cli/src/lib/doc-owners-write.ts` |
| `freshDocOwners` | function | `apps/cli/src/lib/doc-owners-write.ts` |
| `planDocOwnersBinding` | function | `apps/cli/src/lib/doc-owners-write.ts` |
| `renderDocOwnersBindingDiffLine` | function | `apps/cli/src/lib/doc-owners-write.ts` |
| `checksMissingEnvDeclaration` | function | `apps/cli/src/lib/env-lint.ts` |
| `envDeclarationWarning` | function | `apps/cli/src/lib/env-lint.ts` |
| `ENVELOPE_SCHEMA_VERSION` | const | `apps/cli/src/lib/envelope.ts` |
| `printJson` | function | `apps/cli/src/lib/envelope.ts` |
| `toEnvelope` | function | `apps/cli/src/lib/envelope.ts` |
| `countMarkerComments` | function | `apps/cli/src/lib/forge-write.ts` |
| `currentGhLogin` | function | `apps/cli/src/lib/forge-write.ts` |
| `ensureTrancheLabelExists` | function | `apps/cli/src/lib/forge-write.ts` |
| `extractLabels` | function | `apps/cli/src/lib/forge-write.ts` |
| `extractTitle` | function | `apps/cli/src/lib/forge-write.ts` |
| `fetchForgeLabels` | function | `apps/cli/src/lib/forge-write.ts` |
| `ForgeArgError` | class | `apps/cli/src/lib/forge-write.ts` |
| `locateBody` | function | `apps/cli/src/lib/forge-write.ts` |
| `makeCheckError` | function | `apps/cli/src/lib/forge-write.ts` |
| `parseIssueNumberFromRef` | function | `apps/cli/src/lib/forge-write.ts` |
| `postMarkedComment` | function | `apps/cli/src/lib/forge-write.ts` |
| `readProjectPaths` | function | `apps/cli/src/lib/forge-write.ts` |
| `readSharedPackages` | function | `apps/cli/src/lib/forge-write.ts` |
| `refuse` | function | `apps/cli/src/lib/forge-write.ts` |
| `refuseUnlessPrincipal` | function | `apps/cli/src/lib/forge-write.ts` |
| `resolveMilestoneAttachArgs` | function | `apps/cli/src/lib/forge-write.ts` |
| `resolveSections` | function | `apps/cli/src/lib/forge-write.ts` |
| `resolveShippableArgs` | function | `apps/cli/src/lib/forge-write.ts` |
| `runGhWrite` | function | `apps/cli/src/lib/forge-write.ts` |
| `validateForgeWrite` | function | `apps/cli/src/lib/forge-write.ts` |
| `validateIssueContent` | function | `apps/cli/src/lib/forge-write.ts` |
| `validateTaskIssue` | function | `apps/cli/src/lib/forge-write.ts` |
| `writeValidatedIssueEdit` | function | `apps/cli/src/lib/forge-write.ts` |
| `buildGeminiCommandOp` | function | `apps/cli/src/lib/gemini-command-emitter.ts` |
| `GEMINI_COMMAND_GROUP` | const | `apps/cli/src/lib/gemini-command-emitter.ts` |
| `GEMINI_COMMAND_PATH` | const | `apps/cli/src/lib/gemini-command-emitter.ts` |
| `renderGeminiCommand` | function | `apps/cli/src/lib/gemini-command-emitter.ts` |
| `OUTBOX_MAX_BYTES` | const | `apps/cli/src/lib/log-sink.ts` |
| `createLogSink` | function | `apps/cli/src/lib/log-sink.ts` |
| `currentRunId` | function | `apps/cli/src/lib/log-sink.ts` |
| `log` | function | `apps/cli/src/lib/log-sink.ts` |
| `outboxPathFor` | function | `apps/cli/src/lib/log-sink.ts` |
| `EVIDENCE_SUMMARY_PREFIX` | const | `apps/cli/src/lib/numstat.ts` |
| `summariseNumstat` | function | `apps/cli/src/lib/numstat.ts` |
| `applyEject` | function | `apps/cli/src/lib/ops.ts` |
| `applyInstall` | function | `apps/cli/src/lib/ops.ts` |
| `blockStripLeavesEmpty` | function | `apps/cli/src/lib/ops.ts` |
| `containedAbs` | function | `apps/cli/src/lib/ops.ts` |
| `containedManagedBlockAbs` | function | `apps/cli/src/lib/ops.ts` |
| `planEject` | function | `apps/cli/src/lib/ops.ts` |
| `planInstall` | function | `apps/cli/src/lib/ops.ts` |
| `renderEjectDiff` | function | `apps/cli/src/lib/ops.ts` |
| `renderInstallDiff` | function | `apps/cli/src/lib/ops.ts` |
| `resolveManagedBlockPath` | function | `apps/cli/src/lib/ops.ts` |
| `printHelp` | function | `apps/cli/src/lib/output.ts` |
| `packageRoot` | function | `apps/cli/src/lib/package-root.ts` |
| `__resetStdinForTest` | function | `apps/cli/src/lib/prompt.ts` |
| `closeStdin` | function | `apps/cli/src/lib/prompt.ts` |
| `prompt` | function | `apps/cli/src/lib/prompt.ts` |
| `promptYesNo` | function | `apps/cli/src/lib/prompt.ts` |
| `appendRegistryRow` | function | `apps/cli/src/lib/registry-write.ts` |
| `applyConfigProjectEntry` | function | `apps/cli/src/lib/registry-write.ts` |
| `applyRegistryRow` | function | `apps/cli/src/lib/registry-write.ts` |
| `freshProjectsRegistry` | function | `apps/cli/src/lib/registry-write.ts` |
| `planConfigProjectEntry` | function | `apps/cli/src/lib/registry-write.ts` |
| `planRegistryRow` | function | `apps/cli/src/lib/registry-write.ts` |
| `PROJECTS_REGISTRY_PATH` | const | `apps/cli/src/lib/registry-write.ts` |
| `renderConfigProjectEntryDiffLine` | function | `apps/cli/src/lib/registry-write.ts` |
| `renderRegistryRowDiffLine` | function | `apps/cli/src/lib/registry-write.ts` |
| `detectVendoredVinaya` | function | `apps/cli/src/lib/self-host.ts` |
| `VINAYA_PACKAGE_NAME` | const | `apps/cli/src/lib/self-host.ts` |
| `STUDIO_ARTIFACT_ASSET_NAME` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `STUDIO_ARTIFACT_OWNER` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `STUDIO_ARTIFACT_RELEASE_TAG` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `STUDIO_ARTIFACT_REPO` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `STUDIO_NODE_MODULES_PACKED_DIRNAME` | const | `apps/cli/src/lib/studio-bundle.ts` |

(161 exports.)

## Commands — `apps/cli/src/commands` (38 shipped rows, one per `packages/sources/src/commands.ts` entry with `status: 'shipped'`)

| Command | File | Entry function | In-scope calls today | Status | One lib function (compliant) / retirement target (exempt) |
|---|---|---|---|---|---|
| `help` | `(none — router-inline)` | `—` | 0 | compliant | — (built into `apps/cli/src/index.ts`) |
| `version` | `(none — router-inline)` | `—` | 0 | compliant | — (built into `apps/cli/src/index.ts`) |
| `init` | `init.ts` | `initCommand` | 9 | exempt — see below | sharedCommandShell (target) |
| `init product` | `init.ts` | `initProductCommand` | 8 | exempt — see below | sharedCommandShell (target) |
| `check` | `check.ts` | `checkCommand` | 3 | exempt — see below | runChecks (target) |
| `commit-msg` | `commit-msg.ts` | `commitMsgCommand` | 0 | compliant | — (self-contained) |
| `new check` | `new-check.ts` | `newCheckCommand` | 0 | compliant | — (self-contained) |
| `new noop-check` | `new-noop-check.ts` | `newNoopCheckCommand` | 0 | compliant | — (self-contained) |
| `new role` | `new-role.ts` | `newRoleCommand` | 0 | compliant | — (self-contained) |
| `brief render` | `brief.ts` | `briefRenderCommand` | 2 | exempt — see below | sharedCommandShell (target) |
| `pr create` | `pr.ts` | `prCreateCommand` | 9 | exempt — see below | forgeWrite (target) |
| `pr edit` | `pr.ts` | `prEditCommand` | 8 | exempt — see below | forgeWrite (target) |
| `pr report` | `pr-report.ts` | `prReportCommand` | 3 | exempt — see below | collectTokens (target) |
| `pr verify-evidence` | `pr-verify-evidence.ts` | `prVerifyEvidenceCommand` | 3 | exempt — see below | collectTokens (target) |
| `pr rule` | `pr-rule.ts` | `prRuleCommand` | 6 | exempt — see below | forgeWrite (target) |
| `issue create` | `issue.ts` | `issueCreateCommand` | 10 | exempt — see below | forgeWrite (target) |
| `issue edit` | `issue.ts` | `issueEditCommand` | 10 | exempt — see below | forgeWrite (target) |
| `issue objectives edit` | `issue-objectives.ts` | `issueObjectivesEditCommand` | 8 | exempt — see below | forgeWrite (target) |
| `log flush` | `log.ts` | `logFlushCommand` | 4 | exempt — see below | sharedCommandShell (target) |
| `milestone create` | `milestone.ts` | `milestoneCreateCommand` | 8 | exempt — see below | forgeWrite (target) |
| `milestone adopt` | `milestone.ts` | `milestoneAdoptCommand` | 4 | exempt — see below | forgeWrite (target) |
| `milestone edit` | `milestone.ts` | `milestoneEditCommand` | 7 | exempt — see below | forgeWrite (target) |
| `milestone close` | `milestone.ts` | `milestoneCloseCommand` | 4 | exempt — see below | forgeWrite (target) |
| `review status` | `review-status.ts` | `reviewStatusCommand` | 2 | exempt — see below | devReviewLoop (target) |
| `review post` | `review-post.ts` | `reviewPostCommand` | 5 | exempt — see below | devReviewLoop (target) |
| `doctor` | `doctor.ts` | `doctorCommand` | 17 | exempt — see below | sharedCommandShell (target) |
| `tokens` | `tokens.ts` | `tokensCommand` | 1 | compliant | `parseTokensCollectDeclaration` |
| `doctrine` | `doctrine.ts` | `doctrineCommand` | 2 | exempt — see below | sharedCommandShell (target) |
| `upgrade` | `upgrade.ts` | `upgradeCommand` | 19 | exempt — see below | sharedCommandShell (target) |
| `archive` | `archive.ts` | `archiveCommand` | 2 | exempt — see below | collectTokens (target) |
| `archive tranche` | `archive.ts` | `archiveTrancheCommand` | 3 | exempt — see below | collectTokens (target) |
| `audit` | `audit.ts` | `auditCommand` | 2 | exempt — see below | runChecks (target) |
| `eject` | `eject.ts` | `ejectCommand` | 5 | exempt — see below | sharedCommandShell (target) |
| `demo break` | `demo.ts` | `demoBreakCommand` | 3 | exempt — see below | sharedCommandShell (target) |
| `waiver` | `waiver.ts` | `waiverCommand` | 2 | exempt — see below | sharedCommandShell (target) |
| `studio` | `studio.ts` | `runStudio` | 1 | compliant | `packageRoot` |
| `quickstart` | `quickstart.ts` | `quickstartCommand` | 9 | exempt — see below | sharedCommandShell (target) |
| `release` | `release.ts` | `releaseCommand` | 0 | compliant | — (self-contained) |

(38 rows — all 38 shipped `COMMANDS` entries. Compliant: 9. Exempt: 29.)

`review post` refuses a `doc-correctness` finding whose description carries no `Search:` pattern, or whose pattern carries a path filter — a content rule on the existing description field, not a change to the `|`-delimited grammar. The `review post` and `pr rule` source comments describe the verdict-extraction read window, so they carry `AEG:CLAIM` markers pinning the code that proves each claim; `verify-docs` C8 verifies them, and a change to that window fails the check in every file stating it rather than only where a reviewer happened to look. See `aeg-root/documentation-coherence.md`.

## Exemptions

Every non-compliant command from the table above, dated, with the count of distinct in-scope calls its entry function makes today (`apps/cli/src/lib` exports plus, per the Principal's ruling, any call into another `commands/*.ts` file — refused outright, never allowed, but tracked here rather than blocking dispatch of this task) and the chokepoint whose landing retires the row. No command is rewritten in this task.

| Command | Date | Distinct in-scope calls today | Retires via |
|---|---|---|---|
| `init` | 2026-09-05 | 9 — lib (9): `isAgentVendor`, `detectVendoredVinaya`, `readRepoCiSetup`, `buildInitOps`, `planInstall`, `renderInstallDiff`, `applyInstall`, `promptYesNo`, `closeStdin` | `sharedCommandShell` |
| `init product` | 2026-09-05 | 8 — lib (8): `planRegistryRow`, `planConfigProjectEntry`, `renderRegistryRowDiffLine`, `renderConfigProjectEntryDiffLine`, `applyRegistryRow`, `applyConfigProjectEntry`, `promptYesNo`, `closeStdin` | `sharedCommandShell` |
| `check` | 2026-09-05 | 3 — lib: `loadConfigChecked`, `configPath`, `printJson` | `runChecks` |
| `brief render` | 2026-09-05 | 2 — lib: `resolvePrincipalAllowlist`, `loadTrustAnchorConfig` | `sharedCommandShell` |
| `pr create` | 2026-09-05 | 9 — lib (9): `locateBody`, `refuse`, `makeCheckError`, `extractTitle`, `resolveSections`, `validateForgeWrite`, `loadConfigChecked`, `printJson`, `resolveShippableArgs` | `forgeWrite` |
| `pr edit` | 2026-09-05 | 8 — lib (8): `refuse`, `makeCheckError`, `locateBody`, `extractTitle`, `resolveSections`, `validateForgeWrite`, `printJson`, `resolveShippableArgs` | `forgeWrite` |
| `pr report` | 2026-09-05 | 3 — lib: `summariseNumstat`; commands/\*.ts (refused outright): `realDeps`, `meteringRefusalMessage` (`tokens.ts`) | `collectTokens` |
| `pr verify-evidence` | 2026-09-05 | 3 — lib: none; commands/\*.ts (refused outright): `buildReport` (`pr-report.ts`), `compareEvidence`, `renderVerdict` (`pr-verify-evidence-logic.ts`) | `collectTokens` |
| `pr rule` | 2026-09-05 | 6 — lib (6): `refuse`, `makeCheckError`, `refuseUnlessPrincipal`, `countMarkerComments`, `postMarkedComment`, `printJson` | `forgeWrite` |
| `issue create` | 2026-09-05 | 10 — lib (10): `locateBody`, `refuse`, `makeCheckError`, `extractTitle`, `extractLabels`, `validateTaskIssue`, `printJson`, `ensureTrancheLabelExists`, `runGhWrite`, `resolveMilestoneAttachArgs` | `forgeWrite` |
| `issue edit` | 2026-09-05 | 10 — lib (10): `refuse`, `makeCheckError`, `locateBody`, `extractTitle`, `fetchForgeLabels`, `extractLabels`, `validateTaskIssue`, `parseIssueNumberFromRef`, `printJson`, `writeValidatedIssueEdit` | `forgeWrite` |
| `issue objectives edit` | 2026-09-05 | 8 — lib (8): `refuse`, `makeCheckError`, `refuseUnlessPrincipal`, `writeValidatedIssueEdit`, `locateBody`, `countMarkerComments`, `postMarkedComment`, `printJson` | `forgeWrite` |
| `log flush` | 2026-09-06 | 4 — lib (4): `outboxPathFor`, `log`, `currentRunId`, `printJson` | `sharedCommandShell` |
| `milestone create` | 2026-09-05 | 8 — lib (8): `extractTitle`, `refuse`, `makeCheckError`, `locateBody`, `resolveSections`, `validateForgeWrite`, `printJson`, `detectGitRepo` | `forgeWrite` |
| `milestone adopt` | 2026-09-05 | 4 — lib (4): `refuse`, `makeCheckError`, `detectGitRepo`, `printJson` | `forgeWrite` |
| `milestone edit` | 2026-09-05 | 7 — lib (7): `refuse`, `makeCheckError`, `locateBody`, `resolveSections`, `validateForgeWrite`, `printJson`, `detectGitRepo` | `forgeWrite` |
| `milestone close` | 2026-09-05 | 4 — lib (4): `refuse`, `makeCheckError`, `detectGitRepo`, `printJson` | `forgeWrite` |
| `review status` | 2026-09-05 | 2 — lib: `resolvePrincipalAllowlist`, `loadTrustAnchorConfig` | `devReviewLoop` |
| `review post` | 2026-09-05 | 5 — lib: `refuse`, `makeCheckError`, `printJson`, `resolvePrincipalAllowlist`, `loadTrustAnchorConfig` (re-verified after the `--objectives-file` addition — the new resolution/render path calls only `gh` directly and this file's own exported helpers, so the in-scope count is unchanged) | `devReviewLoop` |
| `doctor` | 2026-09-05 | 17 — lib (16): `hookDirFromManifest`, `detectVendoredVinaya`, `readRepoCiSetup`, `resolveAgentVendors`, `buildInitOps`, `isDefaultedAgentVendorPath`, `resolveManagedBlockPath`, `markerLines`, `renderBlock`, `foreignRawHooks`, `starterConfig`, `checksMissingEnvDeclaration`, `envDeclarationWarning`, `lintEnvDeclarations`, `globalChecksIgnoredWarning`, `printJson`; commands/\*.ts (refused outright): `resolveDoctrineRootInfo` (`doctrine.ts`) | `sharedCommandShell` |
| `doctrine` | 2026-09-05 | 2 — lib: `packageRoot`, `printJson` | `sharedCommandShell` |
| `upgrade` | 2026-09-05 | 19 — lib (19): `hookDirFromManifest`, `resolveManagedBlockPath`, `stripBlockFromContent`, `blockStripLeavesEmpty`, `foreignRawHooks`, `activeRawHooks`, `detectVendoredVinaya`, `readRepoCiSetup`, `resolveAgentVendors`, `buildInitOps`, `isDefaultedAgentVendorPath`, `markerLines`, `renderBlock`, `indent`, `writeFileWithDirs`, `createHost`, `appendBlock`, `promptYesNo`, `closeStdin` | `sharedCommandShell` |
| `archive` | 2026-09-05 | 2 — lib: `loadConfig`; commands/\*.ts (refused outright): `realDeps` (`tokens.ts`) | `collectTokens` |
| `archive tranche` | 2026-09-05 | 3 — lib: `promptYesNo`, `closeStdin`; commands/\*.ts (refused outright): `realDeps` (`tokens.ts`) | `collectTokens` |
| `audit` | 2026-09-05 | 2 — lib: `loadConfig`, `printJson` | `runChecks` |
| `eject` | 2026-09-05 | 5 — lib: `planEject`, `renderEjectDiff`, `applyEject`, `promptYesNo`, `closeStdin` | `sharedCommandShell` |
| `demo break` | 2026-09-05 | 3 — lib: `detectGitRepo`, `resolveHookDir`, `resolveManagedBlockPath` | `sharedCommandShell` |
| `waiver` | 2026-09-05 | 2 — lib: `prompt`, `closeStdin` | `sharedCommandShell` |
| `quickstart` | 2026-09-05 | 9 — lib: `planDocOwnersBinding`, `applyDocOwnersBinding`, `renderDocOwnersBindingDiffLine`, `promptYesNo`, `prompt`; commands/\*.ts (refused outright): `runInit` (`init.ts`), `runInitProduct` (`init.ts`), `runDemoBreak` (`demo.ts`), `runDoctor` (`doctor.ts`) | `sharedCommandShell` |
| `pr-verify-evidence-logic.ts` (not a command — see note) | 2026-09-05 | n/a — lib code (`publishedMergeBase`, `normaliseLines`, `compareEvidence`, `renderVerdict`) colocated in `apps/cli/src/commands/` instead of `apps/cli/src/lib/` | moves to `apps/cli/src/lib/` in the next task touching `pr-verify-evidence` |

`dispatchRole` and `runTask` retire no row today — neither chokepoint has a shipped command yet; both are forward-looking per the Tech Spec.

`issue create`/`issue edit` re-verified after `BRIEF_BUILTINS` (`apps/cli/src/lib/config.ts`) and its `runBuiltin` table (`apps/cli/src/lib/forge-write.ts`) gained a `briefSections` entry: both rows' own in-scope call count is unchanged — `validateTaskIssue` was already the one call either row lists, and a new entry inside that function's internal table is not a new call site in either command's own body.

