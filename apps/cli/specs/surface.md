# Surface — the public function index

Status: draft

One command is one function, published and tested. `apps/cli/tests/surface-index.test.ts` enforces the Commands/Exemptions tables below against the real source tree, and `apps/cli/tests/surface-spec-exports.test.ts` enforces the Policy/Effects tables below the same way (O16) — an export added, removed, or renamed without a matching row here fails that test. This file is its source of truth, not the reverse.

## The rule

A command is a function with argument parsing in front. Commands never call commands. One capability is one function.

The tables below index exported functions/consts/classes only — a change that adds or removes none of those (a new field on an already-exported type, a new CLI flag on an already-listed command) needs no new row here and does not make this file stale. (`#548`: the O1 lock hand-over and O2 role-log trace are internal to `devReviewLoop`/`checkStaleDriver`, and `deriveLoopState`'s new third parameter is a new field on an already-exported function, not a new export — same rule, no new row. `DriverExitReason`/`DriverExitTrace`/`LoopLogLookup`, added to `task-status.ts`, are type-only exports; per this file's own scope line above ("functions/consts/classes only"), they get no row either — the same omission `MergeableState`/`PauseState` already have. `#588`: `AssembleAndRenderBriefResult`'s new `dispatchBlockerDetails` field and `makeCheckError`'s new fourth `severity` parameter are both new fields/parameters on already-exported symbols, not new exports — same rule, no new row. `gate-reading.ts`'s `fetchMechanicalCheckRuns` now dedupes by the newest `started_at` instead of the highest run id, and its own `sh()` retries a `gh` read three times, with backoff, before a transient forge hiccup counts as a real failure — both are behavioral changes inside an already-exported function, adding no new export, so no new row.)

Three layers:

- **Policy** — `@attalabs/aeg-core`. Pure functions: no filesystem, no network, no process. Read here, never written by this task.
- **Effects** — `apps/cli/src/lib`. The chokepoints that touch the world: git, the filesystem, the forge, a child process. A future consolidated set (`log`, `flushLog`, `forgeWrite`, `forgeRead`, `runChecks`, `collectTokens`, `dispatchRole`, `devReviewLoop`, `runTask` — Tech Spec "A Task Finishes Itself" §2–§3) does not fully exist yet; today's `apps/cli/src/lib` is a wider micro-library commands compose directly. (`review-validity-v1` task 7, `#498`: `devReviewLoop`'s own one-driver-per-task pid-lock guard is entirely internal to this existing exported function — no new export, per line 11's rule above, so no new table row below.)
- **Commands** — `apps/cli/src/commands`. One file per command (or per closely-related command family sharing a file, e.g. `milestone.ts`). Each command's entry function, reached from `apps/cli/src/index.ts`'s router, should call exactly one effects-layer function. `apps/cli/src/index.ts` itself is the router, not a command, and is exempt by construction.

**Predicate the test enforces (per Principal ruling on Issue #418):** for a command's entry function, collect every call expression (transitively through same-file helpers) whose callee resolves to an export of `apps/cli/src/lib/**` or of another `apps/cli/src/commands/*.ts` file. A call into `apps/cli/src/lib` beyond the one named function is a violation. A call into another `commands/*.ts` file is refused outright — commands never call commands — with zero allowance beyond the same dated-exemption mechanism (no separate carve-out). `printJson`, `promptYesNo`/`closeStdin`, and `packageRoot` count toward the cap like any other call — no allowlist (see Open note below). Calls into `@attalabs/aeg-core` are unrestricted (policy is meant to be composed freely).

**Open note (Principal ruling, 2026-09-05):** `printJson`, `promptYesNo`/`closeStdin`, and `packageRoot` are called by most commands purely for output/prompt/path-resolution plumbing, not business effect. They are not allowlisted out of the cap — they count like any other call — but the shape that will retire most of today's exemptions for install/scaffolding commands (`doctor`, `doctrine`, `eject`, `init`, `init product`, `quickstart`, `upgrade`, `demo break`, `waiver`) is a **shared command shell** consolidating this plumbing, not one of the six chokepoints below. That shell is a later task, named here as `sharedCommandShell` in the Exemptions table until it exists.

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
| `issueBranchName` | function | `packages/aeg-core/src/task-branch-identity.ts` |
| `parseTaskBranchIdentity` | function | `packages/aeg-core/src/task-branch-identity.ts` |
| `extractBoundaryFilePaths` | function | `packages/aeg-core/src/brief-render.ts` |
| `extractSourceRevision` | function | `packages/aeg-core/src/brief-render.ts` |
| `parseRationaleFields` | function | `packages/aeg-core/src/brief-render.ts` |
| `renderBrief` | function | `packages/aeg-core/src/brief-render.ts` |
| `AEG_BRIEF_V1_MARKER` | const | `packages/aeg-core/src/brief-validation.ts` |
| `AGENT_BOXES_REFUSED_SINCE_PR` | const | `packages/aeg-core/src/brief-validation.ts` |
| `briefMarkerFor` | function | `packages/aeg-core/src/brief-validation.ts` |
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
| `checkObjectivesCopy` | function | `packages/aeg-core/src/brief-validation.ts` |
| `checkObjectivesCoverage` | function | `packages/aeg-core/src/brief-validation.ts` |
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
| `contentAfterNLines` | function | `packages/aeg-core/src/brief-validation.ts` |
| `contentAfterTwoLines` | function | `packages/aeg-core/src/brief-validation.ts` |
| `extractFencedBlocks` | function | `packages/aeg-core/src/brief-validation.ts` |
| `frozenBriefContent` | function | `packages/aeg-core/src/brief-validation.ts` |
| `headerRegion` | function | `packages/aeg-core/src/brief-validation.ts` |
| `inferBranchFromBody` | function | `packages/aeg-core/src/brief-validation.ts` |
| `isBriefShaped` | function | `packages/aeg-core/src/brief-validation.ts` |
| `isGrandfatherableBriefRuleError` | function | `packages/aeg-core/src/brief-validation.ts` |
| `isTaskBranch` | function | `packages/aeg-core/src/brief-validation.ts` |
| `packagesNamedIn` | function | `packages/aeg-core/src/brief-validation.ts` |
| `parseBriefMarkerVersion` | function | `packages/aeg-core/src/brief-validation.ts` |
| `PART_CITATION_RE` | const | `packages/aeg-core/src/brief-validation.ts` |
| `partitionBriefErrorsByRollout` | function | `packages/aeg-core/src/brief-validation.ts` |
| `resolveNewestFrozenBrief` | function | `packages/aeg-core/src/brief-validation.ts` |
| `isTokenCollectionWiringBroken` | function | `packages/aeg-core/src/claude-code-transcript.ts` |
| `resolveMeteringCapability` | function | `packages/aeg-core/src/claude-code-transcript.ts` |
| `summarizeTranscript` | function | `packages/aeg-core/src/claude-code-transcript.ts` |
| `checkA1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkA2` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkA3` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkClosesNTopology` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkD1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL2` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL3` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL4` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkL5` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkR1` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkR2` | function | `packages/aeg-core/src/coherence-checks.ts` |
| `checkR3` | function | `packages/aeg-core/src/coherence-checks.ts` |
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
| `assessRound` | function | `packages/aeg-core/src/dev-review-loop/assess-round.ts` |
| `extractLoopEventsFromCommentBody` | function | `packages/aeg-core/src/dev-review-loop/journal-reconstruction.ts` |
| `nextRoundNumber` | function | `packages/aeg-core/src/dev-review-loop/journal-reconstruction.ts` |
| `parseLoopEventLines` | function | `packages/aeg-core/src/dev-review-loop/journal-reconstruction.ts` |
| `reconstructRounds` | function | `packages/aeg-core/src/dev-review-loop/journal-reconstruction.ts` |
| `renderSummary` | function | `packages/aeg-core/src/dev-review-loop/render-summary.ts` |
| `initialLoopState` | function | `packages/aeg-core/src/dev-review-loop/types.ts` |
| `deriveDiagramModel` | function | `packages/aeg-core/src/diagram-model.ts` |
| `checkDirectMainPush` | function | `packages/aeg-core/src/direct-main-push.ts` |
| `checkDispatchReadiness` | function | `packages/aeg-core/src/dispatch-gate.ts` |
| `checkDocClaims` | function | `packages/aeg-core/src/doc-claim.ts` |
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
| `BRIEF_SECTIONS_SINCE_ISSUE` | const | `packages/aeg-core/src/issue-validation.ts` |
| `checkBlastRadiusScope` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkConflictCompleteness` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkDocsWithinSurface` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkIssueBriefSections` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkIssueObjectives` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkIssueRationale` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkIssueType` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkMilestoneAttach` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkNoBriefContent` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkNoForeignTaskOwnership` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkObjectivesRespectBoundary` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkPartsCiteDefinedObjectives` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkPartsCoverageAndSequence` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkProjectsRegistered` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkRationaleNamesDocs` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkRationaleSurfaceCoverage` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkSurfaceExcludesBoundDoc` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkSurfaceGlobsResolve` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkSurfaceOverlap` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkSurfaceScope` | function | `packages/aeg-core/src/issue-validation.ts` |
| `checkTrancheLabelPresence` | function | `packages/aeg-core/src/issue-validation.ts` |
| `declaredProjects` | function | `packages/aeg-core/src/issue-validation.ts` |
| `edgesNameEachOther` | function | `packages/aeg-core/src/issue-validation.ts` |
| `frozenSectionsChanged` | function | `packages/aeg-core/src/issue-validation.ts` |
| `globCoversPath` | function | `packages/aeg-core/src/issue-validation.ts` |
| `isTaskIssueBodyShaped` | function | `packages/aeg-core/src/issue-validation.ts` |
| `isTaskIssueLabelSet` | function | `packages/aeg-core/src/issue-validation.ts` |
| `OBJECTIVES_SINCE_ISSUE` | const | `packages/aeg-core/src/issue-validation.ts` |
| `parseIssueParts` | function | `packages/aeg-core/src/issue-validation.ts` |
| `parseIssueStopConditions` | function | `packages/aeg-core/src/issue-validation.ts` |
| `parseIssueSurface` | function | `packages/aeg-core/src/issue-validation.ts` |
| `parseIssueTestPlan` | function | `packages/aeg-core/src/issue-validation.ts` |
| `classifyLeftover` | function | `packages/aeg-core/src/leftover-detection.ts` |
| `checkLocalAnchorCoverage` | function | `packages/aeg-core/src/local-anchor-coverage.ts` |
| `buildHeader` | function | `packages/aeg-core/src/log/envelope.ts` |
| `redact` | function | `packages/aeg-core/src/log/redact.ts` |
| `DevReviewLoopEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `DispatchEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `EffectEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `ForgeOpSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `ForgeWriteEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `GateEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `GateOutcomeSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `HandoffEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `HeaderMetaV1Schema` | const | `packages/aeg-core/src/log/schema.ts` |
| `HeaderMetaV2Schema` | const | `packages/aeg-core/src/log/schema.ts` |
| `HeaderSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `HOST_VALUES` | const | `packages/aeg-core/src/log/schema.ts` |
| `HostSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `InputVersionsSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `LineageSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `LogEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `OperationEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `OperationResultSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `ProvenanceSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `ROLE_VALUES` | const | `packages/aeg-core/src/log/schema.ts` |
| `RoleAttemptEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `RoleAttemptOutcomeSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `RoleSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `UsageEventSchema` | const | `packages/aeg-core/src/log/schema.ts` |
| `classifyStoredLine` | function | `packages/aeg-core/src/log/store.ts` |
| `createFixtureStore` | function | `packages/aeg-core/src/log/store.ts` |
| `KNOWN_SCHEMA_VERSIONS` | const | `packages/aeg-core/src/log/store.ts` |
| `readPageFrom` | function | `packages/aeg-core/src/log/store.ts` |
| `recordIdentity` | function | `packages/aeg-core/src/log/store.ts` |
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
| `hasObjectivesHeading` | function | `packages/aeg-core/src/objectives.ts` |
| `isIssueNotFoundError` | function | `packages/aeg-core/src/objectives.ts` |
| `objectivesOf` | function | `packages/aeg-core/src/objectives.ts` |
| `objectivesSectionBounds` | function | `packages/aeg-core/src/objectives.ts` |
| `objectivesVersion` | function | `packages/aeg-core/src/objectives.ts` |
| `renderObjectives` | function | `packages/aeg-core/src/objectives.ts` |
| `resolveObjectivesSource` | function | `packages/aeg-core/src/objectives.ts` |
| `parseLedger` | function | `packages/aeg-core/src/parse-ledger.ts` |
| `rowFromCells` | function | `packages/aeg-core/src/parse-ledger.ts` |
| `parseRegistry` | function | `packages/aeg-core/src/parse-registry.ts` |
| `aggregateTaskTokenRows` | function | `packages/aeg-core/src/parse-token-report.ts` |
| `parseTokenReportEntries` | function | `packages/aeg-core/src/parse-token-report.ts` |
| `parseTokensLines` | function | `packages/aeg-core/src/parse-token-report.ts` |
| `parseTranche` | function | `packages/aeg-core/src/parse-tranche.ts` |
| `checkDecisionsDensity` | function | `packages/aeg-core/src/pr-report-density.ts` |
| `checkPrReportDensity` | function | `packages/aeg-core/src/pr-report-density.ts` |
| `checkScopeDensity` | function | `packages/aeg-core/src/pr-report-density.ts` |
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
| `PRODUCT_SLUG_SCOPE` | const | `packages/aeg-core/src/reader-resolvable-prose.ts` |
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
| `briefHash` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `buildReviewInputManifest` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `compareManifest` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `isBoundToBase` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `isBoundToBriefHash` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `isBoundToHead` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `isBoundToObjectives` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `isBoundToPatch` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `isBoundToPolicy` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `isBoundToRulings` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `manifestAsEchoed` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `policyDigest` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `blockingSeverities` | function | `packages/aeg-core/src/review-policy.ts` |
| `CODE_REVIEW_SEVERITY_ORDER` | const | `packages/aeg-core/src/review-policy.ts` |
| `codeReviewBlockingSeverities` | function | `packages/aeg-core/src/review-policy.ts` |
| `DEFAULT_REVIEW_POLICY` | const | `packages/aeg-core/src/review-policy.ts` |
| `evaluateCodeReview` | function | `packages/aeg-core/src/review-policy.ts` |
| `evaluateReviewFindings` | function | `packages/aeg-core/src/review-policy.ts` |
| `evaluateSecurityReview` | function | `packages/aeg-core/src/review-policy.ts` |
| `isKnownSeverity` | function | `packages/aeg-core/src/review-policy.ts` |
| `isProseLocation` | function | `packages/aeg-core/src/review-policy.ts` |
| `SECURITY_SEVERITY_ORDER` | const | `packages/aeg-core/src/review-policy.ts` |
| `securityBlockingSeverities` | function | `packages/aeg-core/src/review-policy.ts` |
| `deriveReviewStatus` | function | `packages/aeg-core/src/review-status.ts` |
| `parseDeveloperRoundMarker` | function | `packages/aeg-core/src/review-status.ts` |
| `renderReviewStatus` | function | `packages/aeg-core/src/review-status.ts` |
| `newestPrincipalRulingOrdinal` | function | `packages/aeg-core/src/ruling-ordinal.ts` |
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
| `VERDICT_MARKER_SOURCE` | const | `packages/aeg-core/src/verdict-extraction.ts` |
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
| `CONTROL_RECORD_VERSION` | const | `packages/aeg-core/src/control-store/records.ts` |
| `parseRunRecord` | function | `packages/aeg-core/src/control-store/records.ts` |
| `parseInputRecord` | function | `packages/aeg-core/src/control-store/records.ts` |
| `parseOwnershipRecord` | function | `packages/aeg-core/src/control-store/records.ts` |
| `parseTransitionRecord` | function | `packages/aeg-core/src/control-store/records.ts` |
| `parseManifestRecord` | function | `packages/aeg-core/src/control-store/records.ts` |
| `parseEffectRecord` | function | `packages/aeg-core/src/control-store/records.ts` |
| `defaultControlStoreDeps` | function | `packages/aeg-core/src/control-store/local.ts` |
| `StaleEpochWriteError` | class | `packages/aeg-core/src/control-store/local.ts` |
| `InvalidRunIdError` | class | `packages/aeg-core/src/control-store/local.ts` |
| `InvalidEffectKeyError` | class | `packages/aeg-core/src/control-store/local.ts` |
| `readCurrentOwnership` | function | `packages/aeg-core/src/control-store/local.ts` |
| `acquireOwnership` | function | `packages/aeg-core/src/control-store/local.ts` |
| `writeRun` | function | `packages/aeg-core/src/control-store/local.ts` |
| `readRun` | function | `packages/aeg-core/src/control-store/local.ts` |
| `writeInput` | function | `packages/aeg-core/src/control-store/local.ts` |
| `readInput` | function | `packages/aeg-core/src/control-store/local.ts` |
| `appendTransition` | function | `packages/aeg-core/src/control-store/local.ts` |
| `readTransitions` | function | `packages/aeg-core/src/control-store/local.ts` |
| `writeManifest` | function | `packages/aeg-core/src/control-store/local.ts` |
| `readManifest` | function | `packages/aeg-core/src/control-store/local.ts` |
| `writeEffect` | function | `packages/aeg-core/src/control-store/local.ts` |
| `readEffect` | function | `packages/aeg-core/src/control-store/local.ts` |
| `defaultIsPidAlive` | function | `packages/aeg-core/src/control-store/migration.ts` |
| `migrateLegacyTask` | function | `packages/aeg-core/src/control-store/migration.ts` |
| `normalizeOutcome` | function | `packages/aeg-core/src/control-store/outcomes.ts` |
| `TASK_TOOL_ERROR_KINDS` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskToolErrorSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `taskToolError` | function | `packages/aeg-core/src/task-tools.ts` |
| `capabilityUnavailable` | function | `packages/aeg-core/src/task-tools.ts` |
| `TaskToolRefSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `DEFAULT_PAGE_LIMIT` | const | `packages/aeg-core/src/task-tools.ts` |
| `MAX_PAGE_LIMIT` | const | `packages/aeg-core/src/task-tools.ts` |
| `PageRequestSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `FreshnessSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `ObservedSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskStatusInputSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskStatusItemSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskStatusResultSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `RequestedAuthoritySchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `EscalationInputsSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `EscalationEvidenceSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskEscalationReadInputSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskEscalationPacketSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskEscalationReadResultSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskStartInputSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskResumeInputSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TaskCancelInputSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `NoResultSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `TASK_TOOL_NAMES` | const | `packages/aeg-core/src/task-tools.ts` |
| `isTaskToolName` | function | `packages/aeg-core/src/task-tools.ts` |
| `TASK_STATUS_TOOL` | const | `packages/aeg-core/src/task-tools.ts` |
| `TASK_ESCALATION_READ_TOOL` | const | `packages/aeg-core/src/task-tools.ts` |
| `TASK_START_TOOL` | const | `packages/aeg-core/src/task-tools.ts` |
| `TASK_RESUME_TOOL` | const | `packages/aeg-core/src/task-tools.ts` |
| `TASK_CANCEL_TOOL` | const | `packages/aeg-core/src/task-tools.ts` |
| `TASK_TOOL_CATALOG` | const | `packages/aeg-core/src/task-tools.ts` |
| `taskToolByName` | function | `packages/aeg-core/src/task-tools.ts` |
| `TaskStartResultSchema` | const | `packages/aeg-core/src/task-tools.ts` |
| `taskStartRequestIdentity` | function | `packages/aeg-core/src/task-tools.ts` |
| `isOperatorGranted` | function | `packages/aeg-core/src/task-tools.ts` |
| `OPERATOR_STATUS_FOLLOW` | const | `packages/aeg-core/src/task-tools.ts` |
| `OPERATOR_TOOL_GRANT` | const | `packages/aeg-core/src/task-tools.ts` |

(349 exports — 5 added by `task-log-v1` task 2: the typed log storage contract (`classifyStoredLine`, `createFixtureStore`, `KNOWN_SCHEMA_VERSIONS`, `readPageFrom`, `recordIdentity`, all in `packages/aeg-core/src/log/store.ts`; its `LogStore`/`ReadRecord`/`ReadPage`/`AppendOutcome`/`OverflowDiagnostic`/`ReadDiagnostics`/`RecordIdentity`/`FixtureStoreOptions` are type-only exports, no row). 4 added by `control-store-v1` task 5 (`#555`): `isBoundToBase` (`review-input-manifest.ts`), `parseManifestRecord` (`control-store/records.ts`), and `writeManifest`/`readManifest` (`control-store/local.ts`) — the base-identity binding and the parent-built manifest record. `ManifestRecord`/`ManifestInput` are type-only exports and get no row, per this file's own rule. 1 added by `control-store-v1` task 3: `normalizeOutcome` (`control-store/outcomes.ts`) — its `NormalizedOutcome`/`OutcomeSignals`/`TaskOutcomeStatus` are type-only exports of the same file and get no row, per this file's own rule. 32 added by `task-operator-v1` task 1, 2 by task 2 (`TaskStartResultSchema` and the pure `taskStartRequestIdentity`, both in `task-tools.ts`), and 3 by task 3 (`isOperatorGranted`/`OPERATOR_STATUS_FOLLOW`/`OPERATOR_TOOL_GRANT` — the Operator's tool grant, the machine-readable twin of `roles/operator.md`'s `allowed-tools`; `OperatorGrantedTool` is type-only and gets no row): the task-tool catalog. `TaskToolDefinition`/`TaskToolError`/`TaskToolErrorKind`/`TaskToolHandlerBinding`/`TaskToolName`/`TaskToolRef`/`Freshness`/`PageRequest`/`RequestedAuthority`/`TaskStatusInput`/`TaskStatusResult`/`TaskEscalationReadInput`/`TaskEscalationReadResult`/`TaskEscalationPacket`/`TaskStartInput`/`TaskResumeInput`/`TaskCancelInput` are type-only exports of the same file — per this file's own rule (line 11, "functions/consts/classes only"), they get no row; the remaining 18 come from `control-store-v1` task 1, merged separately.)

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
| `roleAllowedTools` | function | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `RETIRED_ROLE_NAMES` | const | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `staleAgentSkillPaths` | function | `apps/cli/src/lib/agents-skills-emitter.ts` |
| `ARCHIVIST_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `BODY_CHECKS_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `BRANCH_PROTECTION_NOTE` | const | `apps/cli/src/lib/artifacts.ts` |
| `buildInitOps` | function | `apps/cli/src/lib/artifacts.ts` |
| `CHECKS_FOLDER_PLACEHOLDER_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `CHECKS_WORKFLOW_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `CLI_DIST_ARTIFACT_NAME` | const | `apps/cli/src/lib/artifacts.ts` |
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
| `ownVersion` | function | `apps/cli/src/lib/artifacts.ts` |
| `MCP_JSON_PATH` | const | `apps/cli/src/lib/artifacts.ts` |
| `assembleAndRenderBrief` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `assembleAndRenderBriefForIssue` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `buildWorkspaceConsumersOf` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `canRenderBriefFromHere` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `checkDirtyPinnedFiles` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `checkStaleAgainstRemote` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `DRAFT_ISSUE_SENTINEL` | const | `apps/cli/src/lib/brief-assembly.ts` |
| `expandGlob` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `packageNameForPath` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `resolveBoundaryPaths` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `resolveRemoteDefaultBranch` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `resolveTrancheTaskId` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `sha256OfFile` | function | `apps/cli/src/lib/brief-assembly.ts` |
| `taskNotFoundMessage` | function | `apps/cli/src/lib/brief-assembly.ts` |
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
| `GLOBAL_CONFIG_PATH` | const | `apps/cli/src/lib/config.ts` |
| `GLOBAL_VINAYA_HOME` | const | `apps/cli/src/lib/config.ts` |
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
| `LOCAL_CONFIG_FILENAME` | const | `apps/cli/src/lib/config.ts` |
| `MANAGED_MANIFEST_VERSION` | const | `apps/cli/src/lib/config.ts` |
| `parseTokensCollectDeclaration` | function | `apps/cli/src/lib/config.ts` |
| `readRepoCiSetup` | function | `apps/cli/src/lib/config.ts` |
| `repoLocalConfigDir` | function | `apps/cli/src/lib/config.ts` |
| `resolveAgentVendors` | function | `apps/cli/src/lib/config.ts` |
| `resolvePrincipalAllowlist` | function | `apps/cli/src/lib/config.ts` |
| `resolveReleaseActor` | function | `apps/cli/src/lib/config.ts` |
| `resolveReviewPolicy` | function | `apps/cli/src/lib/config.ts` |
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
| `assertValidLoopEvent` | function | `apps/cli/src/lib/dev-review-loop.ts` |
| `buildReexecArgs` | function | `apps/cli/src/lib/dev-review-loop.ts` |
| `DEV_REVIEW_LOOP_AGENTS` | const | `apps/cli/src/lib/dev-review-loop.ts` |
| `devReviewLoop` | function | `apps/cli/src/lib/dev-review-loop.ts` |
| `sanitizeUncaughtErrorForPublicPause` | function | `apps/cli/src/lib/dev-review-loop.ts` |
| `DRIVER_OWNED_PATHS` | const | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `describeFailingCheckRun` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `fetchCiConclusion` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `fetchConflictingFiles` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `fetchFailingCheckRuns` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `fetchMergeableState` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `gitCommitsTouchingDriverPaths` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `parseMergeTreeConflictFiles` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `readWorktreeHead` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `resolveHead` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `sh` | function | `apps/cli/src/lib/dev-review-loop/gate-reading.ts` |
| `classifyChildLiveness` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `describeObjectivesEdit` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `developerBranchFor` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `DeveloperStopSignal` | class | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `extractObjectivesSection` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `fetchDeveloperStop` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `fetchFrozenBrief` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `fetchIssueLabels` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `fetchIssueTitle` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `fetchNewestRulingOrdinal` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `fetchPrBody` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `fetchRulings` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `fetchSourceRevision` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `filterDeveloperStops` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `filterPrincipalRulings` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `findLatestPrincipalObjectivesEdit` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `findOpenPrForBranch` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `findPrincipalFrozenBrief` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `LaunchContinuityLost` | class | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `markerComments` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `NO_SOURCE_REVISION` | const | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `parseObjectivesEditComment` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `principalAllowlist` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `reconcileLaunch` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `recoverDeveloperLaunch` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `resolveIssueObjectives` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `reviewPolicy` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `taskFromPrBody` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `withPromptFile` | function | `apps/cli/src/lib/dev-review-loop/developer-dispatch.ts` |
| `buildManifestRecord` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `buildVerdictFromReport` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `controlStoreRoot` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `discardHeldVerdicts` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `persistManifestRecord` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `hasObjectivesFacts` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `heldVerdictPath` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `latestHeldRequestChanges` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `lintReviewerPrompt` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `missingReviewerArtifacts` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `outboxRoot` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `readIfExists` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `reclassifyProseOnlyNotMet` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `renderReviewerDispatchPrompt` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `renderReviewerPrompt` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `ReviewerInfrastructureFailure` | class | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `ReviewerReportParseFailure` | class | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `reviewerWorkDir` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `writeHeldVerdict` | function | `apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts` |
| `assertDispatchOrEscalate` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `CONFIDENCE_FILE_NAME` | const | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `CONFIDENCE_PROMPT_LINE` | const | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `DEVELOPER_ROUND_RESPONSE_FILE_NAME` | const | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `developerRoundMarker` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `DevReviewLoopResumeError` | class | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `driverCrashEvents` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `driverDecidedPauseEvents` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `MAX_GATE_STALLED_TURNS` | const | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `parseConfidenceReply` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `parseRoundResponseFindingIds` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `parseShortstat` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `pollUntil` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `renderDeveloperRoundComment` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `ROUND_RESPONSE_PROMPT_LINE` | const | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `routeCompletionEvents` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `sizeOfSafe` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `waitForOwnLoopLine` | function | `apps/cli/src/lib/dev-review-loop/round-assess.ts` |
| `bindingOfPosted` | function | `apps/cli/src/lib/dev-review-loop/publication.ts` |
| `postForgeEffectOnce` | function | `apps/cli/src/lib/dev-review-loop/publication.ts` |
| `publishRound` | function | `apps/cli/src/lib/dev-review-loop/publication.ts` |
| `unboundFields` | function | `apps/cli/src/lib/dev-review-loop/publication.ts` |
| `fetchLoopHistory` | function | `apps/cli/src/lib/dev-review-loop/journal-history.ts` |
| `clearDriverLock` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `isDriverPidAlive` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `pauseMarker` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `postIssuePauseComment` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `postPauseComment` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `printDriverLockLine` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `readDriverLock` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `readPauseState` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `renderNoPushStopComment` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `renderPauseComment` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `sanitizePublicPauseDetail` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `writeDriverLock` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `writePauseState` | function | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` |
| `controlStoreRoot` | function | `apps/cli/src/lib/effects.ts` |
| `createEffectExecutor` | function | `apps/cli/src/lib/effects.ts` |
| `EffectExecutor` | class | `apps/cli/src/lib/effects.ts` |
| `EffectRetryRefusedError` | class | `apps/cli/src/lib/effects.ts` |
| `sha256Hex` | function | `apps/cli/src/lib/effects.ts` |
| `changedLineRanges` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `fileDiffAgainst` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `findingsInThisDiff` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `lineIsInRanges` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `repoRoot` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `resolveChangedFiles` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `resolveDiff` | function | `apps/cli/src/lib/diff-evidence.ts` |
| `DISPATCH_AGENTS` | const | `apps/cli/src/lib/dispatch-task.ts` |
| `dispatchTask` | function | `apps/cli/src/lib/dispatch-task.ts` |
| `DispatchTaskError` | class | `apps/cli/src/lib/dispatch-task.ts` |
| `extractAgentClass` | function | `apps/cli/src/lib/dispatch-task.ts` |
| `prepareIssueTask` | function | `apps/cli/src/lib/dispatch-task.ts` |
| `prepareTask` | function | `apps/cli/src/lib/dispatch-task.ts` |
| `prepareTaskOrIssue` | function | `apps/cli/src/lib/dispatch-task.ts` |
| `resolveModelFromRationale` | function | `apps/cli/src/lib/dispatch-task.ts` |
| `AGENT_CLASS_VALUES` | const | `apps/cli/src/lib/dispatch.ts` |
| `AGENT_VENDOR_NAMES` | const | `apps/cli/src/lib/dispatch.ts` |
| `BACKGROUND_DENY_REASON` | const | `apps/cli/src/lib/dispatch.ts` |
| `backgroundShapeDetectorSource` | function | `apps/cli/src/lib/dispatch.ts` |
| `colourAgentLine` | function | `apps/cli/src/lib/dispatch.ts` |
| `colourEnabled` | function | `apps/cli/src/lib/dispatch.ts` |
| `colourLoopLine` | function | `apps/cli/src/lib/dispatch.ts` |
| `DEFAULT_TIMEOUT_MS` | const | `apps/cli/src/lib/dispatch.ts` |
| `dispatchRole` | function | `apps/cli/src/lib/dispatch.ts` |
| `getProcessSnapshot` | function | `apps/cli/src/lib/dispatch.ts` |
| `matchesCapturedIdentity` | function | `apps/cli/src/lib/dispatch.ts` |
| `HEARTBEAT_INTERVAL_MS` | const | `apps/cli/src/lib/dispatch.ts` |
| `identifyVendorFromModelShape` | function | `apps/cli/src/lib/dispatch.ts` |
| `isAgentClass` | function | `apps/cli/src/lib/dispatch.ts` |
| `isAgentVendor` | function | `apps/cli/src/lib/dispatch.ts` |
| `MAX_TEE_BYTES` | const | `apps/cli/src/lib/dispatch.ts` |
| `openOutputTee` | function | `apps/cli/src/lib/dispatch.ts` |
| `parseClaudeModel` | function | `apps/cli/src/lib/dispatch.ts` |
| `parseClaudeResumeId` | function | `apps/cli/src/lib/dispatch.ts` |
| `parseClaudeUsage` | function | `apps/cli/src/lib/dispatch.ts` |
| `parseGeminiModel` | function | `apps/cli/src/lib/dispatch.ts` |
| `parseGeminiUsage` | function | `apps/cli/src/lib/dispatch.ts` |
| `readLaunchRecord` | function | `apps/cli/src/lib/dispatch.ts` |
| `readResumeRecord` | function | `apps/cli/src/lib/dispatch.ts` |
| `realDispatchTeeRecoveryDeps` | function | `apps/cli/src/lib/dispatch.ts` |
| `recoverUsageFromDispatchTee` | function | `apps/cli/src/lib/dispatch.ts` |
| `renderClaudeEvent` | function | `apps/cli/src/lib/dispatch.ts` |
| `renderCodexEvent` | function | `apps/cli/src/lib/dispatch.ts` |
| `renderGeminiEvent` | function | `apps/cli/src/lib/dispatch.ts` |
| `resolveClassModel` | function | `apps/cli/src/lib/dispatch.ts` |
| `SUBAGENT_BACKGROUND_DENY_REASON` | const | `apps/cli/src/lib/dispatch.ts` |
| `SUITE_RUN_DENY_REASON` | const | `apps/cli/src/lib/dispatch.ts` |
| `terminateChildWithGrace` | function | `apps/cli/src/lib/dispatch.ts` |
| `terminateLaunchedChildOnShutdown` | function | `apps/cli/src/lib/dispatch.ts` |
| `timeoutWarningLeadMs` | function | `apps/cli/src/lib/dispatch.ts` |
| `wholeSuiteTestCommandDetectorSource` | function | `apps/cli/src/lib/dispatch.ts` |
| `writeDispatchSettings` | function | `apps/cli/src/lib/dispatch.ts` |
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
| `collectTaskIssueErrors` | function | `apps/cli/src/lib/forge-write.ts` |
| `countMarkerComments` | function | `apps/cli/src/lib/forge-write.ts` |
| `currentGhLogin` | function | `apps/cli/src/lib/forge-write.ts` |
| `ensureTrancheLabelExists` | function | `apps/cli/src/lib/forge-write.ts` |
| `extractLabels` | function | `apps/cli/src/lib/forge-write.ts` |
| `extractTitle` | function | `apps/cli/src/lib/forge-write.ts` |
| `fetchForgeIssueContext` | function | `apps/cli/src/lib/forge-write.ts` |
| `fetchForgeLabels` | function | `apps/cli/src/lib/forge-write.ts` |
| `ForgeArgError` | class | `apps/cli/src/lib/forge-write.ts` |
| `locateBody` | function | `apps/cli/src/lib/forge-write.ts` |
| `makeCheckError` | function | `apps/cli/src/lib/forge-write.ts` |
| `markedCommentBody` | function | `apps/cli/src/lib/forge-write.ts` |
| `parseIssueNumberFromRef` | function | `apps/cli/src/lib/forge-write.ts` |
| `postMarkedComment` | function | `apps/cli/src/lib/forge-write.ts` |
| `readDocOwnersContent` | function | `apps/cli/src/lib/forge-write.ts` |
| `readProjectPaths` | function | `apps/cli/src/lib/forge-write.ts` |
| `readSharedPackages` | function | `apps/cli/src/lib/forge-write.ts` |
| `reconcileGhComment` | function | `apps/cli/src/lib/forge-write.ts` |
| `refuse` | function | `apps/cli/src/lib/forge-write.ts` |
| `refuseFrozenSectionChange` | function | `apps/cli/src/lib/forge-write.ts` |
| `refuseUnlabeledTaskShapedBody` | function | `apps/cli/src/lib/forge-write.ts` |
| `refuseUnlessPrincipal` | function | `apps/cli/src/lib/forge-write.ts` |
| `resolveMilestoneAttachArgs` | function | `apps/cli/src/lib/forge-write.ts` |
| `resolveSections` | function | `apps/cli/src/lib/forge-write.ts` |
| `resolveShippableArgs` | function | `apps/cli/src/lib/forge-write.ts` |
| `runBodyChecks` | function | `apps/cli/src/lib/forge-write.ts` |
| `runGhWrite` | function | `apps/cli/src/lib/forge-write.ts` |
| `runIssueChecks` | function | `apps/cli/src/lib/forge-write.ts` |
| `validateForgeWrite` | function | `apps/cli/src/lib/forge-write.ts` |
| `validateIssueContent` | function | `apps/cli/src/lib/forge-write.ts` |
| `validateTaskIssue` | function | `apps/cli/src/lib/forge-write.ts` |
| `writeValidatedIssueEdit` | function | `apps/cli/src/lib/forge-write.ts` |
| `buildGeminiCommandOp` | function | `apps/cli/src/lib/gemini-command-emitter.ts` |
| `GEMINI_COMMAND_GROUP` | const | `apps/cli/src/lib/gemini-command-emitter.ts` |
| `GEMINI_COMMAND_PATH` | const | `apps/cli/src/lib/gemini-command-emitter.ts` |
| `renderGeminiCommand` | function | `apps/cli/src/lib/gemini-command-emitter.ts` |
| `flushOutbox` | function | `apps/cli/src/lib/log-flush.ts` |
| `LogFlushError` | class | `apps/cli/src/lib/log-flush.ts` |
| `tailHasOwnLine` | function | `apps/cli/src/lib/log-flush.ts` |
| `createLogSink` | function | `apps/cli/src/lib/log-sink.ts` |
| `currentRunId` | function | `apps/cli/src/lib/log-sink.ts` |
| `log` | function | `apps/cli/src/lib/log-sink.ts` |
| `OUTBOX_MAX_BYTES` | const | `apps/cli/src/lib/log-sink.ts` |
| `outboxPathFor` | function | `apps/cli/src/lib/log-sink.ts` |
| `appendLoopLogLine` | function | `apps/cli/src/lib/loop-log.ts` |
| `appendRoleLine` | function | `apps/cli/src/lib/loop-log.ts` |
| `appendRunStartMarker` | function | `apps/cli/src/lib/loop-log.ts` |
| `followLoopLog` | function | `apps/cli/src/lib/loop-log.ts` |
| `LOOP_LOG_MAX_BYTES` | const | `apps/cli/src/lib/loop-log.ts` |
| `loopLogPathFor` | function | `apps/cli/src/lib/loop-log.ts` |
| `loopsRoot` | function | `apps/cli/src/lib/loop-log.ts` |
| `EVIDENCE_SUMMARY_PREFIX` | const | `apps/cli/src/lib/numstat.ts` |
| `summariseNumstat` | function | `apps/cli/src/lib/numstat.ts` |
| `appendBlock` | function | `apps/cli/src/lib/ops.ts` |
| `applyEject` | function | `apps/cli/src/lib/ops.ts` |
| `applyInstall` | function | `apps/cli/src/lib/ops.ts` |
| `blockStripLeavesEmpty` | function | `apps/cli/src/lib/ops.ts` |
| `containedAbs` | function | `apps/cli/src/lib/ops.ts` |
| `containedManagedBlockAbs` | function | `apps/cli/src/lib/ops.ts` |
| `createHost` | function | `apps/cli/src/lib/ops.ts` |
| `indent` | function | `apps/cli/src/lib/ops.ts` |
| `markerLines` | function | `apps/cli/src/lib/ops.ts` |
| `planEject` | function | `apps/cli/src/lib/ops.ts` |
| `planInstall` | function | `apps/cli/src/lib/ops.ts` |
| `renderBlock` | function | `apps/cli/src/lib/ops.ts` |
| `renderEjectDiff` | function | `apps/cli/src/lib/ops.ts` |
| `renderInstallDiff` | function | `apps/cli/src/lib/ops.ts` |
| `resolveManagedBlockPath` | function | `apps/cli/src/lib/ops.ts` |
| `stripBlockFromContent` | function | `apps/cli/src/lib/ops.ts` |
| `writeFileWithDirs` | function | `apps/cli/src/lib/ops.ts` |
| `printHelp` | function | `apps/cli/src/lib/output.ts` |
| `packageRoot` | function | `apps/cli/src/lib/package-root.ts` |
| `patchIdAt` | function | `apps/cli/src/lib/patch-id.ts` |
| `agentCommandText` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `anyGateFailed` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `bodiesAgreeOutsideRegions` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `buildReport` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `collectTokensAddition` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `composeWrittenBody` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `computeGroupA` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `computeGroupC` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `DEFAULT_COMMAND_TIMEOUT_MS` | const | `apps/cli/src/lib/pr-report-engine.ts` |
| `derivePhase` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `DivergentEvidenceAnchorError` | class | `apps/cli/src/lib/pr-report-engine.ts` |
| `extractAgentCommandLines` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `gh` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `ghEditBody` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `GitCommandError` | class | `apps/cli/src/lib/pr-report-engine.ts` |
| `groupCFailed` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `isoToday` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `MissingEvidenceAnchorError` | class | `apps/cli/src/lib/pr-report-engine.ts` |
| `prReportExitCode` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `realTokenReportCapabilityDeps` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `renderGroupC` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `replaceEvidenceBlock` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `resolveCommandTimeoutMs` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `resolveTokenReportCapability` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `resolveTokenReportCapabilityWith` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `runAgentCommand` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `runReportForOpenPr` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `runRealGates` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `spliceIntoLiveBody` | function | `apps/cli/src/lib/pr-report-engine.ts` |
| `UnresolvableMergeBaseError` | class | `apps/cli/src/lib/pr-report-engine.ts` |
| `writeTokensBlock` | function | `apps/cli/src/lib/pr-report-engine.ts` |
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
| `addedOrRenamedFilesSinceRemoteBase` | function | `apps/cli/src/lib/remote-base.ts` |
| `addedOrRenamedFilesSinceRemoteBaseAbsolute` | function | `apps/cli/src/lib/remote-base.ts` |
| `changedFilesSinceRemoteBase` | function | `apps/cli/src/lib/remote-base.ts` |
| `changedFilesSinceRemoteBaseAbsolute` | function | `apps/cli/src/lib/remote-base.ts` |
| `resolveRemoteBase` | function | `apps/cli/src/lib/remote-base.ts` |
| `REVIEW_GATE_CHECK_RUN_NAME` | const | `apps/cli/src/lib/review-gate-check-name.ts` |
| `detectVendoredVinaya` | function | `apps/cli/src/lib/self-host.ts` |
| `resolveAuthorRepoSourceEntry` | function | `apps/cli/src/lib/self-host.ts` |
| `VINAYA_PACKAGE_NAME` | const | `apps/cli/src/lib/self-host.ts` |
| `STUDIO_ARTIFACT_ASSET_NAME` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `STUDIO_ARTIFACT_OWNER` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `STUDIO_ARTIFACT_RELEASE_TAG` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `STUDIO_ARTIFACT_REPO` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `STUDIO_NODE_MODULES_PACKED_DIRNAME` | const | `apps/cli/src/lib/studio-bundle.ts` |
| `isAlreadyDispatchedError` | function | `apps/cli/src/lib/task-run.ts` |
| `RunTaskError` | class | `apps/cli/src/lib/task-run.ts` |
| `runTask` | function | `apps/cli/src/lib/task-run.ts` |
| `deriveLoopState` | function | `apps/cli/src/lib/task-status.ts` |
| `gatherSingleTaskStatus` | function | `apps/cli/src/lib/task-status.ts` |
| `gatherTaskStatusList` | function | `apps/cli/src/lib/task-status.ts` |
| `lastRoundVerdictLines` | function | `apps/cli/src/lib/task-status.ts` |
| `renderTaskStatusRow` | function | `apps/cli/src/lib/task-status.ts` |
| `resumeCommandFor` | function | `apps/cli/src/lib/task-status.ts` |
| `paginate` | function | `apps/cli/src/lib/task-tools/read.ts` |
| `readTaskLoopStateObserved` | function | `apps/cli/src/lib/task-tools/read.ts` |
| `classifyStateFreshness` | function | `apps/cli/src/lib/task-tools/read.ts` |
| `describeTaskLoopState` | function | `apps/cli/src/lib/task-tools/read.ts` |
| `readEscalationPacket` | function | `apps/cli/src/lib/task-tools/read.ts` |
| `taskStatusHandler` | function | `apps/cli/src/lib/task-tools/handlers.ts` |
| `taskEscalationReadHandler` | function | `apps/cli/src/lib/task-tools/handlers.ts` |
| `taskResumeHandler` | function | `apps/cli/src/lib/task-tools/handlers.ts` |
| `taskCancelHandler` | function | `apps/cli/src/lib/task-tools/handlers.ts` |
| `routeTaskToolIntent` | function | `apps/cli/src/lib/task-tools/router.ts` |
| `refuseUngrantedTool` | function | `apps/cli/src/lib/task-tools/router.ts` |
| `MCP_PROTOCOL_VERSION` | const | `apps/cli/src/lib/task-tools/server.ts` |
| `TASK_TOOLS_MCP_SERVER_NAME` | const | `apps/cli/src/lib/task-tools/server.ts` |
| `CALLER_ENV_VAR` | const | `apps/cli/src/lib/task-tools/server.ts` |
| `resolveCallerFromEnv` | function | `apps/cli/src/lib/task-tools/server.ts` |
| `defaultTaskToolHandlers` | const | `apps/cli/src/lib/task-tools/server.ts` |
| `dispatchToolCall` | function | `apps/cli/src/lib/task-tools/server.ts` |
| `TASK_TOOL_INPUT_JSON_SCHEMAS` | const | `apps/cli/src/lib/task-tools/server.ts` |
| `toolListEntry` | function | `apps/cli/src/lib/task-tools/server.ts` |
| `createTaskToolsMcpServer` | function | `apps/cli/src/lib/task-tools/server.ts` |
| `serveTaskToolsStdio` | function | `apps/cli/src/lib/task-tools/server.ts` |
| `TASK_TOOLS_SERVE_ARGS` | const | `apps/cli/src/lib/task-tools/adapters.ts` |
| `taskToolsServerInvocation` | function | `apps/cli/src/lib/task-tools/adapters.ts` |
| `CLAUDE_MCP_ADAPTER` | const | `apps/cli/src/lib/task-tools/adapters.ts` |
| `CODEX_MCP_ADAPTER` | const | `apps/cli/src/lib/task-tools/adapters.ts` |
| `MCP_RUNTIME_ADAPTERS` | const | `apps/cli/src/lib/task-tools/adapters.ts` |
| `claudeMcpJsonConfig` | function | `apps/cli/src/lib/task-tools/adapters.ts` |
| `claudeMcpJsonFile` | function | `apps/cli/src/lib/task-tools/adapters.ts` |
| `codexMcpServersToml` | function | `apps/cli/src/lib/task-tools/adapters.ts` |
| `defaultRequestStore` | const | `apps/cli/src/lib/task-tools/start.ts` |
| `TASK_RUN_COMMAND_ENV` | const | `apps/cli/src/lib/task-tools/start.ts` |
| `defaultLaunch` | function | `apps/cli/src/lib/task-tools/start.ts` |
| `defaultTaskStartDeps` | const | `apps/cli/src/lib/task-tools/start.ts` |
| `createTaskStartHandler` | function | `apps/cli/src/lib/task-tools/start.ts` |
| `defaultTaskStartHandler` | const | `apps/cli/src/lib/task-tools/start.ts` |
| `DEFAULT_PACKET_BUDGET` | const | `apps/cli/src/lib/context-packet.ts` |
| `parseContextPacket` | function | `apps/cli/src/lib/context-packet.ts` |
| `renderContextPacket` | function | `apps/cli/src/lib/context-packet.ts` |
| `validateContextPacket` | function | `apps/cli/src/lib/context-packet.ts` |
| `compactPacket` | function | `apps/cli/src/lib/context-packet.ts` |
| `continuationPacket` | function | `apps/cli/src/lib/context-packet.ts` |
| `classifyOperatorRequest` | function | `apps/cli/src/lib/context-packet.ts` |
| `discoverWorkspacePackages` | function | `apps/cli/src/lib/test-selector.ts` |
| `extractImportSpecifiers` | function | `apps/cli/src/lib/test-selector.ts` |
| `isTestFile` | function | `apps/cli/src/lib/test-selector.ts` |
| `resolveRelativeImport` | function | `apps/cli/src/lib/test-selector.ts` |
| `selectAffectedTestFiles` | function | `apps/cli/src/lib/test-selector.ts` |
| `walkFiles` | function | `apps/cli/src/lib/test-selector.ts` |
| `AEG_BRIEF_V1_MARKER` | const | `packages/aeg-core/src/brief-validation.ts` |
| `briefHash` | function | `packages/aeg-core/src/review-input-manifest.ts` |
| `contentAfterTwoLines` | function | `packages/aeg-core/src/brief-validation.ts` |

(308 exports — 5 added by `control-store-v1` task 5 (`#555`): `buildManifestRecord`, `controlStoreRoot`, and `persistManifestRecord` (`dev-review-loop/reviewer-dispatch.ts`) — the parent that builds and persists the review manifest record — plus `bindingOfPosted`/`unboundFields` (`dev-review-loop/publication.ts`, round 2 review: exported so their base/brief/objectives/ruling/policy binding logic, previously untested, gets direct fixture coverage). `ManifestRecordIdentity` is a type-only export and gets no row. 4 added by `control-store-v1` task 3: `readLaunchRecord` (`dispatch.ts`) exposes the durable launch record's full lifecycle for recovery; `reconcileLaunch`/`recoverDeveloperLaunch` (`dev-review-loop/developer-dispatch.ts`, O3) reconcile a prior launch before continuing; `LaunchContinuityLost` is the class the recovery throws when a required session is gone. Their `LaunchRecord`/`LaunchStatus`/`ParsedLaunch` (`dispatch.ts`) and `LaunchReconciliation`/`ReconcileLaunchDeps` (`developer-dispatch.ts`) are type-only exports and get no row, per this file's own rule. 11 added by `task-operator-v1` task 1: `apps/cli/src/lib/task-tools/read.ts` and `handlers.ts` bind `task_status`/`task_escalation_read` to today's outbox and forge reads, and `router.ts` classifies a caller's free-text intent to one catalog tool name. None of the three files front a `vinaya` subcommand yet — the catalog they implement is an agent-facing tool surface, not a CLI command — so no Commands-table row exists for any of them; `Observed`/`Page` (`read.ts`) and `TaskToolCallResult` (`handlers.ts`) are type-only exports and get no row either, per this file's own rule. Task 2 adds 25 more, net: the shared MCP server (`server.ts`, 10), the two runtime adapters (`adapters.ts`, 8), and the `task_start` handler (`start.ts`, 6), plus `ownVersion`/`MCP_JSON_PATH` on `artifacts.ts`; `taskStartHandler` moved off `handlers.ts` into `start.ts` as `defaultTaskStartHandler`. Task 2's read/handler files still front no `vinaya` subcommand each — but `vinaya task-tools serve` (`commands/task-tools.ts`) now fronts the server, the one Commands-table row this surface gained. Type-only exports (`CallerContext`/`ToolHandler`/`StartRecord` and the adapter/deps types) get no row, per this file's own rule. 2 more added by `task-operator-v1` task 3 O2: `router.ts`'s `refuseUngrantedTool` — wired into `server.ts`'s `dispatchToolCall` as the production grant gate every MCP tool call passes through, before its handler runs — and `agents-skills-emitter.ts`'s `roleAllowedTools` (reads a role's `allowed-tools` frontmatter so the generated skill carries the same grant); and 7 more by task 3 O3, all in `context-packet.ts` — the bounded context-packet model (`parseContextPacket`, `renderContextPacket`, `validateContextPacket`, `compactPacket`, `continuationPacket`, `classifyOperatorRequest`, `DEFAULT_PACKET_BUDGET`); its `ContextPacket`/`EvidenceEntry`/`PacketIssue`/`PacketIssueKind`/`RequestClassification`/`ContextPacketRole` are type-only and get no row. 5 added by `driver-lifecycle-v1` task 1 (Issue #605): `getProcessSnapshot`/`terminateChildWithGrace`/`terminateLaunchedChildOnShutdown` (`dispatch.ts`) give the driver's own shutdown path (O1) and recovery's orphan-reaping (O2) a real process-identity read and a graduated-signal termination, shared by both; `matchesCapturedIdentity` (`dispatch.ts`, round 4 security review, HIGH) is the one identity guard `terminateLaunchedChildOnShutdown` and `classifyChildLiveness` (`developer-dispatch.ts`, O2/O3) now both call, so a recycled pid is refused identically whether it is being reaped on recovery or signaled on shutdown — an earlier version of the shutdown path signaled `record.childPid` on no identity check at all. `ProcessSnapshot` (`dispatch.ts`) is a type-only export and gets no row, per this file's own rule. 1 more added by `driver-lifecycle-v1` task 2 (`#607`, O3): `describeFailingCheckRun` (`dev-review-loop/gate-reading.ts`) — `fetchFailingCheckNames` renamed to `fetchFailingCheckRuns` in place, not a new export.)

## Commands — `apps/cli/src/commands` (45 shipped rows, one per `packages/sources/src/commands.ts` entry with `status: 'shipped'`)

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
| `brief render` | `brief.ts` | `briefRenderCommand` | 1 | compliant | `assembleAndRenderBrief` |
| `task dispatch` | `task.ts` | `taskDispatchCommand` | 1 | compliant | `dispatchTask` |
| `task brief` | `task.ts` | `taskBriefCommand` | 1 | compliant | `prepareTaskOrIssue` |
| `task run` | `task-run.ts` | `taskRunCommand` | 3 | exempt — see below | sharedCommandShell (target) |
| `task status` | `task-status.ts` | `taskStatusCommand` | 5 | exempt — see below | taskStatus (target) |
| `task-tools serve` | `task-tools.ts` | `taskToolsServeCommand` | 2 | exempt — see below | sharedCommandShell (target) |
| `pr create` | `pr.ts` | `prCreateCommand` | 13 | exempt — see below | forgeWrite (target) |
| `pr edit` | `pr.ts` | `prEditCommand` | 10 | exempt — see below | forgeWrite (target) |
| `pr report` | `pr-report.ts` | `prReportCommand` | 5 | exempt — see below | collectTokens (target) |
| `pr verify-evidence` | `pr-verify-evidence.ts` | `prVerifyEvidenceCommand` | 3 | exempt — see below | collectTokens (target) |
| `pr rule` | `pr-rule.ts` | `prRuleCommand` | 6 | exempt — see below | forgeWrite (target) |
| `issue create` | `issue.ts` | `issueCreateCommand` | 11 | exempt — see below | forgeWrite (target) |
| `issue edit` | `issue.ts` | `issueEditCommand` | 12 | exempt — see below | forgeWrite (target) |
| `issue objectives edit` | `issue-objectives.ts` | `issueObjectivesEditCommand` | 11 | exempt — see below | forgeWrite (target) |
| `log flush` | `log.ts` | `logFlushCommand` | 2 | exempt — see below | sharedCommandShell (target) |
| `milestone create` | `milestone.ts` | `milestoneCreateCommand` | 8 | exempt — see below | forgeWrite (target) |
| `milestone adopt` | `milestone.ts` | `milestoneAdoptCommand` | 4 | exempt — see below | forgeWrite (target) |
| `milestone edit` | `milestone.ts` | `milestoneEditCommand` | 7 | exempt — see below | forgeWrite (target) |
| `milestone close` | `milestone.ts` | `milestoneCloseCommand` | 4 | exempt — see below | forgeWrite (target) |
| `milestone status` | `milestone.ts` | `milestoneStatusCommand` | 4 | exempt — see below | forgeWrite (target) |
| `review status` | `review-status.ts` | `reviewStatusCommand` | 3 | exempt — see below | devReviewLoop (target) |
| `review post` | `review-post.ts` | `reviewPostCommand` | 6 | exempt — see below | devReviewLoop (target) |
| `doctor` | `doctor.ts` | `doctorCommand` | 17 | exempt — see below | sharedCommandShell (target) |
| `tokens` | `tokens.ts` | `tokensCommand` | 1 | compliant | `parseTokensCollectDeclaration` |
| `doctrine` | `doctrine.ts` | `doctrineCommand` | 2 | exempt — see below | sharedCommandShell (target) |
| `upgrade` | `upgrade.ts` | `upgradeCommand` | 22 | exempt — see below | sharedCommandShell (target) |
| `archive` | `archive.ts` | `archiveCommand` | 2 | exempt — see below | collectTokens (target) |
| `archive tranche` | `archive.ts` | `archiveTrancheCommand` | 3 | exempt — see below | collectTokens (target) |
| `audit` | `audit.ts` | `auditCommand` | 2 | exempt — see below | runChecks (target) |
| `eject` | `eject.ts` | `ejectCommand` | 5 | exempt — see below | sharedCommandShell (target) |
| `demo break` | `demo.ts` | `demoBreakCommand` | 3 | exempt — see below | sharedCommandShell (target) |
| `waiver` | `waiver.ts` | `waiverCommand` | 2 | exempt — see below | sharedCommandShell (target) |
| `studio` | `studio.ts` | `runStudio` | 1 | compliant | `packageRoot` |
| `quickstart` | `quickstart.ts` | `quickstartCommand` | 9 | exempt — see below | sharedCommandShell (target) |
| `release` | `release.ts` | `releaseCommand` | 0 | compliant | — (self-contained) |
| `dispatch` | `dispatch.ts` | `dispatchCommand` | 5 | exempt — see below | sharedCommandShell (target) |
| `dev-review-loop` | `dev-review-loop.ts` | `devReviewLoopCommand` | 5 | exempt — see below | sharedCommandShell (target) |

(44 rows — all 44 shipped `COMMANDS` entries. Compliant: 12. Exempt: 32.)

`review post` refuses a `doc-correctness` finding whose description carries no `Search:` pattern, or whose pattern carries a path filter — a content rule on the existing description field, not a change to the `|`-delimited grammar. The `review post` and `pr rule` source comments describe the verdict-extraction read window, so they carry `AEG:CLAIM` markers pinning the code that proves each claim; `verify-docs` C8 verifies them, and a change to that window fails the check in every file stating it rather than only where a reviewer happened to look. See `aeg-root/documentation-coherence.md`.

## Exemptions

Every non-compliant command from the table above, dated, with the count of distinct in-scope calls its entry function makes today (`apps/cli/src/lib` exports plus, per the Principal's ruling, any call into another `commands/*.ts` file — refused outright, never allowed, but tracked here rather than blocking dispatch of this task) and the chokepoint whose landing retires the row. No command is rewritten in this task.

| Command | Date | Distinct in-scope calls today | Retires via |
|---|---|---|---|
| `init` | 2026-09-05 | 9 — lib (9): `isAgentVendor`, `detectVendoredVinaya`, `readRepoCiSetup`, `buildInitOps`, `planInstall`, `renderInstallDiff`, `applyInstall`, `promptYesNo`, `closeStdin` | `sharedCommandShell` |
| `init product` | 2026-09-05 | 8 — lib (8): `planRegistryRow`, `planConfigProjectEntry`, `renderRegistryRowDiffLine`, `renderConfigProjectEntryDiffLine`, `applyRegistryRow`, `applyConfigProjectEntry`, `promptYesNo`, `closeStdin` | `sharedCommandShell` |
| `check` | 2026-09-05 | 3 — lib: `loadConfigChecked`, `configPath`, `printJson` | `runChecks` |
| `pr create` | 2026-09-14 | 13 — lib (13): `locateBody`, `refuse`, `makeCheckError`, `extractTitle`, `resolveSections`, `validateForgeWrite`, `loadConfigChecked`, `printJson`, `resolveShippableArgs`, `derivePhase`, `isoToday`, `resolveTokenReportCapability`, `writeTokensBlock` (the last four all `pr-report-engine.ts`, splicing the `AEG:TOKENS` row into the body at open and refusing a `Premise:` pin the base branch does not yet carry — neither is a new command call: both stay inside this same target's own effects-layer file) | `forgeWrite` |
| `pr edit` | 2026-09-11 | 10 — lib (10): `refuse`, `makeCheckError`, `locateBody`, `extractTitle`, `resolveSections`, `validateForgeWrite`, `runBodyChecks`, `parseIssueNumberFromRef`, `printJson`, `resolveShippableArgs` | `forgeWrite` |
| `pr report` | 2026-09-13 | 8 — lib (8): `gh`, `buildReport`, `collectTokensAddition`, `composeWrittenBody`, `ghEditBody`, `runReportForOpenPr`, `prReportExitCode` (`pr-report-engine.ts`), `runBodyChecks` (`forge-write.ts`) | `collectTokens` |
| `pr verify-evidence` | 2026-09-05 | 3 — lib: `buildReport` (`pr-report-engine.ts`, moved out of `pr-report.ts` so a command never calls a command); commands/\*.ts (refused outright): `compareEvidence`, `renderVerdict` (`pr-verify-evidence-logic.ts`) | `collectTokens` |
| `pr rule` | 2026-09-05 | 6 — lib (6): `refuse`, `makeCheckError`, `refuseUnlessPrincipal`, `countMarkerComments`, `postMarkedComment`, `printJson` | `forgeWrite` |
| `issue create` | 2026-09-11 | 11 — lib (11): `locateBody`, `refuse`, `makeCheckError`, `extractTitle`, `extractLabels`, `refuseUnlabeledTaskShapedBody`, `validateTaskIssue`, `printJson`, `ensureTrancheLabelExists`, `runGhWrite`, `resolveMilestoneAttachArgs` | `forgeWrite` |
| `issue edit` | 2026-09-11 | 12 — lib (12): `refuse`, `makeCheckError`, `locateBody`, `extractTitle`, `fetchForgeLabels`, `extractLabels`, `refuseUnlabeledTaskShapedBody`, `refuseFrozenSectionChange`, `validateTaskIssue`, `parseIssueNumberFromRef`, `printJson`, `writeValidatedIssueEdit` | `forgeWrite` |
| `issue objectives edit` | 2026-09-14 | 11 — lib (11): `refuse`, `makeCheckError`, `refuseUnlessPrincipal`, `writeValidatedIssueEdit`, `locateBody`, `countMarkerComments`, `postMarkedComment`, `printJson`, `resolvePrincipalAllowlist`, `loadTrustAnchorConfig`, `prepareTaskOrIssue` | `forgeWrite` |
| `log flush` | 2026-09-11 | 2 — lib (2): `flushOutbox`, `printJson` | `sharedCommandShell` |
| `milestone create` | 2026-09-05 | 8 — lib (8): `extractTitle`, `refuse`, `makeCheckError`, `locateBody`, `resolveSections`, `validateForgeWrite`, `printJson`, `detectGitRepo` | `forgeWrite` |
| `milestone adopt` | 2026-09-05 | 4 — lib (4): `refuse`, `makeCheckError`, `detectGitRepo`, `printJson` | `forgeWrite` |
| `milestone edit` | 2026-09-05 | 7 — lib (7): `refuse`, `makeCheckError`, `locateBody`, `resolveSections`, `validateForgeWrite`, `printJson`, `detectGitRepo` | `forgeWrite` |
| `milestone close` | 2026-09-05 | 4 — lib (4): `refuse`, `makeCheckError`, `detectGitRepo`, `printJson` | `forgeWrite` |
| `milestone status` | 2026-09-10 | 4 — lib (4): `detectGitRepo`, `refuse`, `makeCheckError`, `printJson` | `forgeWrite` |
| `review status` | 2026-09-13 | 3 — lib: `resolvePrincipalAllowlist`, `loadTrustAnchorConfig`, `reviewPolicy` (round-2 review, MEDIUM, `#547`, O4 — the round cap is repository policy, read through the same `reviewPolicy()` resolver `dev-review-loop.ts` already calls, never a hardcoded constant) | `devReviewLoop` |
| `review post` | 2026-09-11 | 6 — lib: `refuse`, `makeCheckError`, `printJson`, `resolvePrincipalAllowlist`, `loadTrustAnchorConfig`, `resolveReviewPolicy` (which severities block is repository policy, `review-validity-v1` task 8, `#506`, O1 — the derivation and its contradiction check now resolve `policy` once via `resolveReviewPolicy` before deriving or cross-checking a verdict) | `devReviewLoop` |
| `doctor` | 2026-09-05 | 17 — lib (16): `hookDirFromManifest`, `detectVendoredVinaya`, `readRepoCiSetup`, `resolveAgentVendors`, `buildInitOps`, `isDefaultedAgentVendorPath`, `resolveManagedBlockPath`, `markerLines`, `renderBlock`, `foreignRawHooks`, `starterConfig`, `checksMissingEnvDeclaration`, `envDeclarationWarning`, `lintEnvDeclarations`, `globalChecksIgnoredWarning`, `printJson`; commands/\*.ts (refused outright): `resolveDoctrineRootInfo` (`doctrine.ts`) | `sharedCommandShell` |
| `doctrine` | 2026-09-05 | 2 — lib: `packageRoot`, `printJson` | `sharedCommandShell` |
| `upgrade` | 2026-09-08 | 22 — lib (21): `hookDirFromManifest`, `resolveManagedBlockPath`, `stripBlockFromContent`, `blockStripLeavesEmpty`, `foreignRawHooks`, `activeRawHooks`, `detectVendoredVinaya`, `readRepoCiSetup`, `resolveAgentVendors`, `buildInitOps`, `isDefaultedAgentVendorPath`, `markerLines`, `renderBlock`, `indent`, `writeFileWithDirs`, `createHost`, `appendBlock`, `promptYesNo`, `closeStdin`, `staleAgentSkillPaths`, `containedAbs`; commands/\*.ts (refused outright): `resolveDoctrineRoot` (`doctrine.ts`) | `sharedCommandShell` |
| `archive` | 2026-09-05 | 2 — lib: `loadConfig`; commands/\*.ts (refused outright): `realDeps` (`tokens.ts`) | `collectTokens` |
| `archive tranche` | 2026-09-05 | 3 — lib: `promptYesNo`, `closeStdin`; commands/\*.ts (refused outright): `realDeps` (`tokens.ts`) | `collectTokens` |
| `audit` | 2026-09-05 | 2 — lib: `loadConfig`, `printJson` | `runChecks` |
| `eject` | 2026-09-05 | 5 — lib: `planEject`, `renderEjectDiff`, `applyEject`, `promptYesNo`, `closeStdin` | `sharedCommandShell` |
| `demo break` | 2026-09-05 | 3 — lib: `detectGitRepo`, `resolveHookDir`, `resolveManagedBlockPath` | `sharedCommandShell` |
| `waiver` | 2026-09-05 | 2 — lib: `prompt`, `closeStdin` | `sharedCommandShell` |
| `quickstart` | 2026-09-05 | 9 — lib: `planDocOwnersBinding`, `applyDocOwnersBinding`, `renderDocOwnersBindingDiffLine`, `promptYesNo`, `prompt`; commands/\*.ts (refused outright): `runInit` (`init.ts`), `runInitProduct` (`init.ts`), `runDemoBreak` (`demo.ts`), `runDoctor` (`doctor.ts`) | `sharedCommandShell` |
| `pr-verify-evidence-logic.ts` (not a command — see note) | 2026-09-05 | n/a — lib code (`publishedMergeBase`, `normaliseLines`, `compareEvidence`, `renderVerdict`) colocated in `apps/cli/src/commands/` instead of `apps/cli/src/lib/` | moves to `apps/cli/src/lib/` in the next task touching `pr-verify-evidence` |
| `dispatch` | 2026-09-11 | 5 — lib (5): `loadConfig`, `isAgentVendor`, `dispatchRole`, `flushOutbox`, `printJson` | `sharedCommandShell` |
| `dev-review-loop` | 2026-09-10 | 5 — lib: `loadConfig`, `isAgentVendor`, `devReviewLoop`, `printJson`, `colourLoopLine` | `sharedCommandShell` |
| `task run` | 2026-09-11 | 3 — lib: `runTask`, `colourLoopLine`, `loadConfig` | `sharedCommandShell` |
| `task status` | 2026-09-12 | 5 — lib: `printJson`, `gatherTaskStatusList`, `gatherSingleTaskStatus`, `loopLogPathFor`, `followLoopLog` | `taskStatus` |
| `task-tools serve` | 2026-09-14 | 2 — lib: `serveTaskToolsStdio`, `ownVersion` | `sharedCommandShell` |

`dispatchRole` retires no row today — its own command (`dispatch`) is new, not a retirement of an existing exempt row. `devReviewLoop` (this task) likewise retires no row today — it is itself a new named chokepoint (`## Effects` intro), and `dev-review-loop`'s own command calls it alongside the same three argv-plumbing calls `dispatch` already carries (`loadConfig`/`isAgentVendor`/`printJson`) — once `sharedCommandShell` absorbs those, this command is left calling only `devReviewLoop`, becoming compliant on its own rather than needing a second named target.

`issue create`/`issue edit` re-verified after `BRIEF_BUILTINS` (`apps/cli/src/lib/config.ts`) and its `runBuiltin` table (`apps/cli/src/lib/forge-write.ts`) gained a `briefSections` entry: both rows' own in-scope call count is unchanged — `validateTaskIssue` was already the one call either row lists, and a new entry inside that function's internal table is not a new call site in either command's own body.

`dispatchRole` (Issue #450, dispatch observability) gained five exports — `DEFAULT_TIMEOUT_MS`, `HEARTBEAT_INTERVAL_MS`, `MAX_TEE_BYTES`, `openOutputTee` and `timeoutWarningLeadMs`, all listed above — and dropped none. They are exported to be reachable from a test at all: the observability behaviours cannot be asserted through `dispatchRole` alone without spawning a real vendor process. `AGENT_VENDOR_NAMES`/`dispatchRole`/`isAgentVendor` are unchanged. Issue #447's O5 adds five more — `parseClaudeUsage` and `parseClaudeResumeId`, exported so a test can assert they read a stream's terminal event as well as a single whole-blob payload, and the three `render*Event` functions, one per vendor, that turn that vendor's own stream into the lines an operator reads while the agent works.

`assembleAndRenderBrief`'s own resolved-Issue result field (Issue #447, O1) is a new field on its already-exported return type, not a new function/const/class export — per this file's own rule (`## The rule`), it needs no new row here. `task dispatch` (`taskDispatchCommand`) still calls only `dispatchTask`, unchanged.

`dispatch-task.ts`'s `dispatchTask` (Issue #492, task-run-v1 task 8) now reaches `dispatchRole` through a static import from `dispatch.ts`, not the runtime-built `import('./dispatch.js')` lookup it used before — that lookup never resolved inside the single-file bundle `apps/cli/scripts/build.ts` produces, so the published CLI's `task dispatch --agent` always fell back to a printed manual-recovery instruction. The fallback function and its hand-rolled `DispatchRoleFn`/`DispatchRoleOpts` mirror types are deleted; `dispatchTask`'s own exported surface and `task dispatch`'s one-lib-call count (`dispatchTask`, above) are unchanged — the composition inside `dispatchTask` changed, not what it exposes or what `taskDispatchCommand` calls.

`dispatchRole` (Issue #491, role-prefixed and coloured terminal output) gains three exports — `colourEnabled`, `colourAgentLine`, `colourLoopLine`, all listed above — and drops none. Exported so a fixture stream can assert the TTY/`NO_COLOR` predicate and the per-role prefix directly, without spawning a real vendor process. Applied only at the point a line reaches `process.stderr`/`process.stdout` (never where a line is produced), so `openOutputTee`'s own tee and `dispatchRole`'s existing `[vinaya dispatch <id>] …` lifecycle-line text are unaffected by this addition; `dev-review-loop`'s own two `process.stdout.write` calls (`devReviewLoopCommand`) now route their text through `colourLoopLine`, calling only `dispatch.ts`'s already-exported surface — one new in-scope lib call, raising that command's own exemption row from 4 to 5 (both the Commands table and the Exemptions row below, updated together).

`prepareTask` (task-run-v1 task 1, O1) is the preparation half extracted from what used to be all of `dispatchTask`'s body — it retires no row today (`dispatchTask` remains, deprecated, and stays `task dispatch`'s own one lib call, unchanged); it was, at that task, the one lib function `task brief` (`taskBriefCommand`) called.

`prepareIssueTask` (`dispatch-task.ts`) is `prepareTask`'s tranche-less twin (task-run-v1 task 15, O1) — same authorization/supersede/frozen-comment rules, sourced from `assembleAndRenderBriefForIssue` (`brief-assembly.ts`) instead of the tranche-keyed renderer, for a backlog Issue with no `vinaya/tranche:*` label. `taskBriefCommand` can now dispatch either shape (`<tranche> <n>` or `--issue <n>`), so it no longer calls `prepareTask` directly: `prepareTaskOrIssue` (`dispatch-task.ts`) is the one chokepoint it calls instead, branching internally to `prepareTask`/`prepareIssueTask` — `task brief`'s own compliance status and one-lib-call count are unchanged (still `1`), only the named function it calls.

`runTask` (task-run-v1 task 2) is the new named chokepoint the `## Effects` intro already anticipated — the "forward-looking, no shipped command yet" caveat above no longer applies. It composes `prepareTask` (`dispatch-task.ts`, unchanged) with `devReviewLoop` (`dev-review-loop.ts`, unchanged — this task calls it, never edits it). Retires no row: neither composed function's own exemption/compliance status changes.

`task run` (`taskRunCommand`) is **exempt**, not compliant — round 2 review (MAJOR): the fresh-task publish/pause summary lines needed role-colouring through `colourLoopLine` (`dispatch.ts`, already exported), the same treatment `dev-review-loop`'s own equivalent lines already carry, raising this command's own in-scope call count from `1` to `2` (`runTask` plus `colourLoopLine`) — both the Commands table row and the new Exemptions row above updated together, same convention the `dev-review-loop` colour addition itself used one commit earlier. `RunTaskResult` (`task-run.ts`) also gained a `prUrl: string | null` field, built from `resolveRepo()` (`@attalabs/aeg-forge-state`, already used by `dev-review-loop.ts`) plus the loop's own `prNumber` — round 2 review, MAJOR: Issue #480's own Sizing story promises the publish path "printing the PR URL," which the shipped command did not do. `null` only when the repo cannot be resolved, never thrown — a display-only nicety, not a new refusal.

Round 2 review, second round (security, HIGH/MEDIUM): `taskRunCommand` now catches every `runTask` failure itself and exits `3` (a new, distinct exit code — never `1`, which pause alone owns), and its own argv parser (`parseFlags`) now collects unrecognized flags into an explicit refusal (exit `2`) instead of silently dropping them, mirroring the fix `dispatch.ts`'s own `parseArgs`/`KNOWN_FLAGS` already made for the identical gap on that sibling command. Neither change touches this command's in-scope lib-call count (still `2`: `runTask`, `colourLoopLine`) or its exemption status.

`taskRunCommand` now falls back to `dispatch.agent` in `vinaya.config.json` when `--agent` is omitted entirely (task-run-v1 task 13), the same fallback `dispatch`/`dev-review-loop` already give their own `--agent` flags — a new call to `loadConfig` (`apps/cli/src/lib/config.ts`, already exported), raising this command's own in-scope lib-call count from `2` to `3` (`runTask`, `colourLoopLine`, `loadConfig`; both the Commands table and the Exemptions row above updated together). Still exempt, not compliant — the target migration is unchanged.

`CheckSpec.principalOwed` (review-validity-v1 task 11, O1) is a new optional field on `CheckSpec`, an already-exported type (`apps/cli/src/checks/contract.ts`) — per this file's own rule (`## The rule`), a field on an already-exported type needs no new row. The matching `CheckEntry` field in `apps/cli/src/lib/config.ts` (`CheckEntrySchema`) is the same kind of addition. `check.ts`'s new `isRunFailed` export is the `checkCommand` entry function's own exit-code aggregation, pulled out for direct unit coverage — it calls no `apps/cli/src/lib` export, so the `check` row's in-scope call count above (`3`) is unchanged. `check-test-plan.ts`'s `buildTestPlanCheckErrors` is an export of `apps/cli/src/checks/bin/check-test-plan.ts`, outside this file's three indexed layers (Policy/Effects/Commands) entirely, so it needs no row either. (Same task, O2: `check-review-gate.ts`'s `uncheckedPrincipalReason` is the identical case — checks/bin/*.ts, no row.)

`killGraceMs` (task-run-v1 task 20, O2) is a new optional field on `VinayaConfigSchema`'s `dispatch` object, an already-exported const (`apps/cli/src/lib/config.ts`) — per this file's own rule (`## The rule`), a field on an already-exported const needs no new row. It overrides the SIGTERM-to-SIGKILL grace window `dispatchRole` (`apps/cli/src/lib/dispatch.ts`) already enforced at a hardcoded constant, so a test proving the escalation itself happens can configure a small, real, non-zero window instead of paying the production-sized default. `dispatchRole`'s own exported surface and exemption status are unchanged. (`apps/cli/src/checks/runner.ts`'s own `KILL_GRACE_MS`/`RunOptions` are out of this task's declared Surface — `apps/cli/src/checks` — and were left untouched; its own timeout-ceiling tests stay at their measured baseline, listed as such in the PR body.)

`apps/cli/src/lib/test-selector.ts` and `apps/cli/src/lib/remote-base.ts` (task-run-v1 task 20, O6/O5 — the pre-push hook's real import-graph test selector and its shared "changed since remote base" computation) are two new files under `apps/cli/src/lib/`, each with real function exports, added as new rows above. `apps/cli/src/lib/pre-push-select-tests.ts` and `apps/cli/src/lib/pre-push-changed-files.ts` are also new files in the same directory but need no rows: both are standalone entrypoint scripts (the same shape `apps/cli/src/checks/bin/*.ts` already uses, one layer over) whose only top-level code is an unexported `main()` called at module scope — zero exported functions/consts/classes, so per this file's own rule there is nothing for a row to name. `scripts/build.ts` bundles both into `dist/lib/` and two new `package.json` `bin` entries (`vinaya-select-tests`, `vinaya-changed-files`) ship them for adopters — the same `npx --yes -p @attalabs/vinaya@<version> <bin>` shape `hookRun`'s own adopter branch already uses for the routed `vinaya` entrypoint, applied to a second and third bin that bypass the CLI's own argv router entirely.

`dispatch` (PR #544, round 2 review, SECURITY HIGH) gains a `--role-log-path <path>` flag on `commands/dispatch.ts`, threading into `dispatchRole`'s own already-declared `DispatchOpts.roleLogPath` field — per this file's own rule (`## The rule`, line 11), a new CLI flag on an already-listed command needs no new row; `dispatchCommand` still calls only `dispatchRole`, unchanged. The flag exists so a test can drive `appendRoleLine`'s redaction fix below through a real dispatched run rather than importing `dispatchRole` in-process (this file's test conventions never do that — `GLOBAL_VINAYA_HOME` is frozen at import from the real machine's `$HOME`). Inside `dispatchRole` itself, the rendered-agent-event line reaching `appendRoleLine` (the role-prefixed mirror to `opts.roleLogPath`) is now passed through `redact` (`@attalabs/aeg-core`, already unrestricted for this layer to call) first — the same scrub `openOutputTee`'s own tee already applied, previously missing on this second sink, so a token a dispatched agent's own tool output echoed reached the role log unredacted. No new export either side of that fix.

`dispatchRole` (`control-store-v1` task 3, O1) now writes a durable **launch record** — run, attempt, role, plus the child pid and the vendor session id — to the same `~/.vinaya/dispatch-resume/<repo>/<role>-<agent>-<scope>.json` file its resume record already used, BEFORE it spawns, binding the session id the moment the stream first reports it and marking the record `interrupted` (never deleting it) on a timeout/crash/refusal. This closes the "failed attempts can lose session identity" defect: an attempt the driver's own death interrupts mid-turn keeps its session for recovery. `readResumeRecord` becomes a bound-session view over that record (unchanged signature, so `dev-review-loop.ts`'s injected `readResumeRecord` dep is unchanged); the new `readLaunchRecord` (row above) exposes the full lifecycle with a corrupt-vs-absent read, mirroring `control-store-v1`'s own `ParsedRecord` discipline. `dispatchRole`'s own signature and every other export are unchanged; `LaunchRecord`/`LaunchStatus`/`ParsedLaunch` are type-only exports and get no row. The launch record deliberately stays this launcher's own machine-local file rather than a `control-store-v1` ownership record — the generic launcher claims no task epoch (the driver's control-store adoption is deferred, `apps/cli/specs/loop.md`), and no strict versioned schema carries a `role`/`attempt`/vendor-`sessionId` field, the same reason the vendor session id has always stayed out of the Vinaya Log's `DispatchOutcomeSchema`.

`developer-dispatch.ts` (`control-store-v1` task 3, O3) gains launch recovery: `reconcileLaunch` (pure — takes a `ParsedLaunch` and injected pid-liveness, returns a `LaunchReconciliation` naming a live, finished, resumable, gone, or absent prior launch) and `recoverDeveloperLaunch` (its disk-and-pid-reading wrapper for the developer, whose worker continuity is required — never a reviewer, which is always dispatched fresh). `LaunchContinuityLost` is the class the driver's resume seam throws when recovery finds a required session gone; the loop's existing outer `catch` turns it into the decided `pause{reason:'infrastructure'}` every other thrown driver-path failure already becomes (`apps/cli/specs/loop.md`), so no new pause plumbing or `PauseReason` is added. `LaunchReconciliation`/`ReconcileLaunchDeps` are type-only exports and get no row. `driver-lifecycle-v1` task 1 code review, MAJOR: `ReconcileLaunchDeps` gains a `terminateChild` field (defaulting to `terminateChildWithGrace` in `defaultReconcileLaunchDeps`); `recoverDeveloperLaunch`'s O2 reap step calls `deps.terminateChild`, never `terminateChildWithGrace` directly, giving that step a test seam.

