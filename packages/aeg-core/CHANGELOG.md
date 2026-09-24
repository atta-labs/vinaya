# @atta/aeg-core

## 0.32.0

### Minor Changes

- 25f63aa: Logs never reach a tracker or a code host, in any form. `vinaya log flush`, `vinaya log export-artifact`, `vinaya log collect-artifact`, and the `logPublish` config key that backed them are removed — a config still carrying `logPublish` is refused, naming `logs` (the live destination `vinaya.config.json` already supports) as its replacement. `@attalabs/aeg-core` drops `validateTaskLogArtifact`/`TASK_LOG_ARTIFACT_MAX_BYTES` and the `ArtifactExpectedProvenance`/`ArtifactGap`/`ArtifactValidationResult` types along with the deleted collect path.
  
  `vinaya init`/`vinaya upgrade` no longer generate a task-log-collector workflow or an artifact-export step in `vinaya-checks.yml`; `vinaya upgrade` removes both from a repository that already has them. A CI job's own gate events now deliver live to a configured `logs.url` server destination — a same-repository or default-branch run delivers when a `logs.headers` credential is present; a fork pull request (which never receives a repository secret) records nothing and says so in the job's own output, never falling back to the ephemeral runner's own disk.

### Patch Changes

- 5604fdb: The dev-review loop now rebuilds its round history — round numbers, which rounds happened, and whether the ready-for-merge summary was actually published — from the control store and the pull request's own principal-authored forge markers (developer round markers and the published summary comment), never from a log event, a flushed log comment, or the telemetry outbox. The Vinaya Log is telemetry and is never read to recover a run, so recovery no longer breaks when the log destination moves off the tracker.
  
  A round that merely decided to publish is no longer mistaken for one that published: the honest signal is the summary comment's presence on the forge, so a crash between a green round and its publication still reconstructs as unpublished and resumes on the next round rather than restarting numbering. Per-round values a marker cannot carry (finding counts, confidence, wall time, files changed) are reported unavailable rather than fabricated.
- @attalabs/aeg-forge-state@0.32.0
  - @attalabs/aeg-types@0.32.0

## 0.31.0

### Patch Changes

- 193a568: A review verdict now binds to a PR even when the base branch advances, as long as the PR head remains unchanged. The base commit is still recorded for audit, but moving the base alone no longer invalidates a verdict. Only when the candidate head does not bind at all (a different revision, not an equivalent rebase) is the base checked as a separate fact. Abbreviated base echoes that do not properly prefix the current base still fail-closed, preserving safety against corrupted or stale abbreviations.
- a8b077b: A `Depends-on`/`Conflicts-with` edge written with a `#` prefix is a forge Issue number and is never ambiguous, whatever tranches its Milestone holds — only a bare, hash-less task number on a multi-tranche Milestone still refuses.
  
  The cross-task Surface-overlap check now exempts two open task Issues sharing a Milestone when either depends on the other, directly or through a chain of `Depends-on` edges within that same Milestone cohort — such tasks can never run at the same time, so an overlapping Surface between them is no longer a false positive.
- 53d5459: From the second round on, the dev-review-loop's `gate_result_read` log event carries the developer's stated confidence at the point the loop reads it: the whole-number value and one-line reason as stated, or `confidence_unavailable: true` for a missing or malformed statement, plus `extra_turn_spent` telling a first statement apart from one made after the confidence rule's one extra developer turn. All four fields are optional, so a `gate_result_read` line logged before this change still parses. Round one and a red gate carry none of them, and the confidence rule itself is unchanged. The event fires on every gate call within a round, not only the round's first — a re-ask that recovers a real statement after an absent first read gets its own event, rather than leaving the round's log stuck on the earlier `confidence_unavailable: true`. Exports `CONFIDENCE_REASON_MAX_LENGTH`, the bound shared by the schema and the parser that captures the reason, so a reason longer than the schema allows is truncated at capture instead of failing validation and dropping the whole event.
- 6bc12cb: The developer-review loop no longer pauses on "no finding was marked resolved." The round assessment's two-consecutive-rounds-resolve-nothing stop read a resolved-id signal that no reviewer observation ever fills, so it paused loops that had actually addressed every finding after any two consecutive changes-requested rounds. That stop condition and the streak state it needed are removed; consecutive changes-requested rounds now keep dispatching the developer, bounded by the round cap. The `no_progress` reason is retained for the driver's own attach-redelivery pause and for already-written journals; the reappearance check, the round cap, the confidence rule, escalation, and the uncitable-ids resend are unchanged.
- c6e8e40: A new `principal-test-plan-wait` check owns the merge condition an unticked `[principal]` Test Plan item represents, as its own independent check: red while any such item is unticked, green once every one is ticked or none exist. It reuses the same tick-detection `test-plan` already runs rather than reimplementing the checkbox scan, and reports only the `[principal]`-unticked branch — a missing Test Plan section stays `test-plan`'s own structural failure to grade.
  
  It is reported by its own job in the generated `vinaya-body-checks.yml`, never by the aggregate `check --all`, so its red can never turn another check's name red; that job re-evaluates on a PR body edit through the workflow's existing trigger, so ticking a box actually re-runs it.
  
  The developer-review loop's mechanical gate now excludes this check's own check-run name from what makes a head's CI red, the same treatment the review-gate check-run already gets — a head whose only red is this check reads as green there, so no developer round is dispatched over the Principal's own wait, while every other red check-run still counts.
- 529c790: The review gate now checks reviews and nothing else. It used to fail whenever any other check-run on the pull request's head was red, or whenever a `[principal]` Test Plan box was still unticked — so a red sibling check was reported twice under two names, and a generated workflow existed only to re-run the gate when CI completed so it could read those other results. That input is gone from the evaluator, from both of its callers, and from the generated workflow set: `vinaya init`/`vinaya upgrade` no longer write the CI-complete re-run workflow. A verdict comment still re-evaluates the gate, and every verdict-binding rule (head, base, objectives version, brief hash, ruling ordinal, policy digest) is unchanged.
  
  Adopters whose repositories already carry the retired workflow should delete `.github/workflows/vinaya-review-retrigger.yml` and drop it from `managed.files` in `vinaya.config.json`; `upgrade` regenerates managed artifacts but does not remove a retired one. Merge conditions the gate no longer enforces need their own required checks — the repository's CI is already one, and an unticked `[principal]` Test Plan item is now unenforced unless a check owns it.
- 320d1ee: `mkdirNoSymlinks` now takes a `trustedRoot` boundary: a symlinked ancestor strictly above it (an operating-system-owned default temp root, such as macOS's `/var` -> `/private/var`) is resolved and its real target ownership/mode-checked rather than refused outright, while a symlink at or below `trustedRoot` is still refused unconditionally. Every run-directory writer in `@attalabs/vinaya` now passes its own `runtimeDir` as that boundary, so creating a run directory under the platform's own default temp root no longer throws.
- f6dc754: Every writer that creates a run-file directory (the control store's own atomic writes, and `apps/cli`'s `ensureRunDir` — the one chokepoint every task-execution directory under a configured `runtimeDir` goes through) now refuses a pre-existing symlink, or a pre-existing real directory it cannot trust the owner or mode of, at any missing ancestor instead of silently writing through it. `mkdirNoSymlinks` (new, exported from `@attalabs/aeg-core`) creates each missing directory level individually and verifies it — never following a symlink, and, for a directory already there, refusing one owned by neither this process nor root, or one left world-writable with no sticky bit — before proceeding. A co-tenant on a shared, multi-account `runtimeDir` (the documented `/var/lib/vinaya/runs` shape) can no longer pre-plant a symlink, nor a real directory it owns or leaves open, to redirect a task's driver lock, ownership-epoch files, effects, resolutions, escalation records, or an unpublished reviewer's findings into a directory it controls.
- 7feb58c: A driver that cannot post its pause or escalation comment now retries the post with backoff for a bounded period instead of exiting the whole process — the local pause record is written first and stays authoritative regardless of whether the comment ever lands, and the next `--resume` posts the missing copy, once, before continuing.
  
  A developer session that ends because the vendor could not be reached (a launcher-classified `'connection-failed'` exit, detected from the vendor's own confirmed-live connection-retry signal) is waited-and-re-dispatched on the same session, bounded by the existing infrastructure-retry budget, and only pauses with that reason once the bound is exhausted — it never records a stop decision the developer did not make.
  
  Both paths log a new `dev_review_loop` event, `infrastructure_retry`, naming the failure kind, the attempt count and the outcome — additive to the schema, so a line recorded before this change still parses.
  
  A driver started from a ruling authenticates it once, at `--resume`'s own start; a later stale-driver re-exec of that same run no longer rebuilds `--resume <pr>` (which re-ran the resume gate against an already-consumed resolution and crashed with no pause) — it always reattaches with `--task <n>` instead, the same door an ordinary restart already uses.
- Updated dependencies [a8b077b]
  - @attalabs/aeg-forge-state@0.31.0
  - @attalabs/aeg-types@0.31.0

## 0.30.0

### Minor Changes

- d24a823: `reader-resolvable-prose` gains a source-comment class: it scans comment lines of `.ts` files under `proseGates.sourceComments.globs` in `vinaya.config.json` for a tranche-slug or forge-number citation, honours `proseGates.sourceComments.allowlist`, and reports at `warning` severity until `proseGates.sourceComments.severity` is set to `error`. `tranchesAttachedToMilestone` and `vinaya archive tranche`'s Issue fetch now paginate past the first 100-item page instead of silently truncating a large Milestone.

### Patch Changes

- bae5ba6: Task operations, loop transitions and handoffs emit one correlated history. The shared effect executor (`EffectExecutor`) emits `effect` log events (`attempted`/`observed`/`verified`) around every real write and every idempotent replay, keyed by the same control-store key used for retry identity; the broker's `authenticate*Invocation`/`requestEffect` emit `operation` events for invocation and authorization outcomes before delegating to the executor. `devReviewLoop` now logs a `resumed` event on `--resume` (`by: 'driver'` for a bare infrastructure recovery, `'principal'` otherwise — a new, additive `resumed.by` member) and `cancelDevReviewLoop` logs a new `cancelled` `dev_review_loop` event, both previously invisible to the Vinaya Log. Every event one driver process emits now shares `meta.lineage.run`: `VINAYA_RUN` is set to the run's own `loop_id`, and the log sink defaults `lineage.run` to the process's own `run_id` when unset, so `effect`/`operation`/`dev_review_loop` events from one run are provably one correlated history rather than independently-correlated streams.
- Updated dependencies [d24a823]
  - @attalabs/aeg-forge-state@0.30.0
  - @attalabs/aeg-types@0.30.0

## 0.29.0

### Minor Changes

- 8cbb973: Review evidence now binds base identity and a complete, durable policy identity. The review-input manifest gains a base commit (`baseSha`) and folds the round-policy field (`maxRounds`) into `policyDigest`; `compareManifest` applies a bounded acceptance rule — an exact-head match also requires the base to match (a base-only change invalidates), while a proven patch-identity rebase tolerates a base move (an equivalent rebase keeps). The manifest is persisted per round as a new `manifest` control-store record kind (`writeManifest`/`readManifest`/`parseManifestRecord`), and the merge gate, the dev-review-loop self-check, and publication all apply the same binding on every field.
  
  New `@attalabs/aeg-core` exports: `isBoundToBase`, `parseManifestRecord`, `writeManifest`, `readManifest` (plus the `ManifestRecord`/`ManifestInput` types). Verdict comments carry a `Judged base:` line; a comment cast before this change (no base echo) needs one fresh review round against a resolvable base, the same one-time transition every other manifest field already took.
- a68d081: Adds `## Documentation` as a fifth Issue-native judgment section, alongside `## Surface`/`## Parts`/`## Test plan`/`## Stop conditions`: a bullet list naming each normative source (a doc URL, an in-repo spec) against the mechanism it governs, or the explicit `None` sentinel. `parseIssueDocumentation` is the new parser (`IssueDocumentation`/`IssueDocumentationSource` are the new types); `checkIssueBriefSections` folds its presence into the same gate, on its own later cutover (`DOCUMENTATION_SINCE_ISSUE`, #626) so no existing Issue is invalidated. `renderBrief` copies the section verbatim into the rendered brief, right after Objectives.
- 74a6c4a: Task-path CI evidence now survives its own job log. `vinaya init`/`upgrade` install a new generated workflow, `vinaya-task-log-collector.yml`, that runs on the default branch with its own credential: it downloads the artifact a task-path job's new "Export task-log artifact" step uploads (bounded, exported even on failure or cancellation), validates it — schema, size, redaction, and a repo-provenance cross-check — and publishes only the accepted records through the existing flush path, reporting every rejected record as a named gap. New `@attalabs/aeg-core` exports: `validateTaskLogArtifact`, `TASK_LOG_ARTIFACT_MAX_BYTES` (plus the `ArtifactExpectedProvenance`/`ArtifactGap`/`ArtifactValidationResult` types). New CLI commands: `vinaya log export-artifact` and `vinaya log collect-artifact`.
- 8404193: Persist and read Vinaya Log event batches without silent loss or duplicate identities.
  
  `packages/aeg-core/src/log/store.ts` adds a typed storage contract — `append`, `readPage`, `acknowledge` — with stable record identities, an idempotent append, overflow diagnostics, version/provenance-validated read-back that keeps unknown-version records for diagnosis, and a deterministic in-memory fixture backend. The GitHub adapter behind `vinaya log flush` implements the contract: it classifies and re-redacts each line through it and skips re-posting a chunk whose marker already exists on the forge, so a flush retry after a lost acknowledgement no longer repeats a remotely accepted batch.
- 5593816: Register the task-operator tools on Claude and Codex, and start one authorized run.
  
  A shared, transport-agnostic MCP server (`vinaya task-tools serve`) binds the
  task-tool catalog to its handlers and speaks newline-delimited JSON-RPC 2.0 over
  stdio. Two runtime adapters register the same server: Claude via a generated
  `.mcp.json`, Codex via its documented `[mcp_servers]` TOML. `task_start` wraps
  the existing `runTask` composition — attended mode only, requiring an
  authenticated caller from the invocation context, idempotent per request
  identity, returning the durable run identity; there is no unattended path yet.
- 712b4a4: The task Operator has a role, a grant, and bounded context. `roles/operator.md` and its two seam contracts (`principal-operator.md`, `planner-operator.md`) declare a task-scoped actor with process authority only — it starts selected planned work, reads grounded status, presents the persisted escalation, and requests authenticated continuation or cancellation, but never plans, codes, edits an Issue, rules, approves, or merges. Role discovery, the `/vinaya operator` command, and the generated skill all expose the same `allowed-tools` grant (the five task tools plus the status-follow read), sourced from one machine-readable `OPERATOR_TOOL_GRANT` the router's `refuseUngrantedTool` enforces. A bounded context-packet model (`context-packet.ts`, doctrine in `skills/aeg-context-packets/`) keeps a packet's authoritative constraints and version-pinned evidence index intact across compaction and continuation, and stays safe against an oversized input, scope creep, a prompt-injection attempt, missing evidence, and an ambiguous request.
- d5898ab: `task_resume` and `task_cancel` are real handlers now, replacing the `capability_unavailable` stubs. Neither accepts a caller-supplied approval: both require a current Principal ruling read fresh off the run's own PR, never a value taken from a tool argument. `task_resume` reads the pause record, the durable escalation record, and any existing resolution before triggering the SAME `dev-review-loop --resume` continuation the CLI has always used, guarded by an idempotent, escalation-scoped claim so the same paused escalation is never handed to two concurrent continuations. `task_cancel` delegates its entire authenticated consumption to the existing `cancelDevReviewLoop`, translating its result into a truthful `confirmed`/`pending`/`uncertain` outcome that a repeated call reports again rather than erroring. `TaskResumeResultSchema`/`TaskCancelResultSchema`/`TaskCancelOutcomeSchema` are the new `@attalabs/aeg-core` exports; `NoResultSchema` is retired.

### Patch Changes

- 7c85f5d: Adds an `effect` record kind to the control store: one file per key, carrying an external write's identity (operation, target, input version, payload digest) and its status (`started`/`verified`/`uncertain`), fenced by the task's current ownership epoch the same way every other write already is. `writeEffect`/`readEffect`/`parseEffectRecord`/`InvalidEffectKeyError` are the new exports.
- 293349c: Role launches and sessions gain durable identities and truthful outcomes. `dispatchRole` persists a launch record (run, attempt, role) before spawning, binds the vendor session id the moment the stream reports it, and keeps the record on an interrupted attempt so session identity survives an interruption. A new `normalizeOutcome` classifies a launch as completed, incomplete, infrastructure-failed, timed-out, cancelled, or capability-refused, deciding from artifacts and postconditions rather than exit code. The dev-review-loop reconciles a live, finished, or uncertain prior launch before continuing — resuming the exact session when required and pausing explicitly when it is gone.
- e3a4775: Adds a `loop_state` record kind to the control store: one per task, carrying the dev-review-loop's round, phase, mechanical/review/infrastructure retry budgets, and held-result/delivered-findings identity — `writeLoopState`/`readLoopState`/`parseLoopStateRecord` are the new exports. The dev-review-loop driver persists it on every round transition and recovers from it on start, attach and `--resume`, so a killed or restarted driver resumes the same round and budgets instead of resetting them, never redelivers the same round's findings twice, and stops depending on the task's optional forge-flushed event history alone for round-number recovery.
- bb403b4: Persisted human decisions resume or cancel only their intended run. Adds `escalation` and `resolution` record kinds to the control store: an escalation record carries a pause's run identity, input versions, reason, evidence, attempted recovery and recipient without requiring chat history; a resolution is claimed exclusively per escalation (`consumeResolutionOnce`), so a second attempt — replayed, stale, or targeting the wrong PR — is refused rather than silently repeating. `listStartedEffectKeys`/`markEffectUncertain` advance an unconfirmed in-flight effect to `uncertain` under a fencing epoch. `vinaya dev-review-loop --resume <pr>` now consumes a resolution before continuing; a new `vinaya dev-review-loop --cancel <pr>` durably and idempotently cancels a paused run, terminates any in-flight worker through its own identity, and fences late results.
- 4065069: `vinaya task run <tranche> <n> --agent <vendor> --background` (and the `--issue <n>` form) starts the controller as a detached second process and returns a durable run handle only once the control store has recorded an acquired ownership epoch and the child's own identity under it. The controller survives the calling terminal or conversation exiting, runs in its own process group, and has its output routed into the same per-task loop log `task status --follow` already tails. `task status` itself now falls back to this same record to report a background controller by pid before its own driver lock lands. A repeated `--background` call against a still-live controller reattaches to the same run instead of starting another; a restart after a crash fences that controller's unconfirmed effect writes before acquiring a fresh epoch; a host that cannot supervise a detached process (no POSIX process groups) refuses before anything is launched. The control store's `run` record gains an optional `childStartedAt`/`childCommand` identity pair for this.
- 9cd9385: Role attempts record review evidence and observed model usage. `dispatchRole` emits a `role_attempt` line per attempt (runtime/model, retry ordinal, evidence identity, a normalized outcome) and a `usage` line with input/output/cache broken out and an explicit reason whenever a vendor's stream gives nothing to report — both survive a killed or crashed attempt, not only a clean exit. A successful dispatch's `outcome_received` line now reports the new `DispatchOutcome` `completed` variant instead of a borrowed `plan` placeholder. `DevReviewLoopEvent`'s `verdicts_read` gains an optional `findings` array carrying each finding's severity scale and policy treatment, populated by the reviewer dispatch from the effective review policy; an invalid reviewer report now also logs its own `role_attempt` failure observation. `PROSE_CAP_SEVERITY` is newly exported from `@attalabs/aeg-core`.
- @attalabs/aeg-forge-state@0.29.0
  - @attalabs/aeg-types@0.29.0

## 0.28.0

### Minor Changes

- 21219e7: A typed task-tool catalog — `task_start`, `task_status`, `task_escalation_read`, `task_resume`, `task_cancel` — is the one place a task-operator tool's name, input/result/error schema and boundaries are written, each with schema-valid examples and a handler-binding pointer. `task_status` and `task_escalation_read` are bound to a real read interface over today's outbox records; the three mutating tools refuse every call with a typed `capability_unavailable` error until a control store exists for them to act on.

### Patch Changes

- @attalabs/aeg-forge-state@0.28.0
  - @attalabs/aeg-types@0.28.0

## 0.27.2

### Patch Changes

- 5859c91: Adds `@attalabs/aeg-core`'s control-store: versioned run/input/ownership/transition records with a strict parser that refuses an unknown version or torn content as corrupt (never as absent), one local storage implementation with atomic durable writes and epoch-fenced ownership (a stale-epoch write is refused inside the store, not left to the caller to check), and a one-time migration from the dev-review-loop's legacy `driver.pid.json`/`pause-state.json`/`effect-*.json` side files. Not yet wired into the live driver — this is the new store and its migration path; adoption is a later task.
- 83e0ffc: `@attalabs/aeg-core`'s `edgesNameEachOther` (backing the cross-task `## Surface` overlap check) now recognises a slug-qualified `Conflicts-with` edge (`<slug> #n` or `<slug> n`) as naming Issue `n`, the same qualification the dispatch gate's own bare-edge rule already requires — a `Conflicts-with` edge written in that form now satisfies both gates without being written twice.
  
  `vinaya issue create`/`edit`'s rendered-brief validation now folds an unmerged `Depends-on` or an open `Conflicts-with` PR into the write gate as an informational (`severity: 'warning'`) finding rather than a refusal of the edit — those facts describe the forge's current state, not a defect in the Issue being edited. `vinaya task run`/`task dispatch` is unaffected and continues refusing on either exactly as before.
- @attalabs/aeg-forge-state@0.27.2
  - @attalabs/aeg-types@0.27.2

## 0.27.1

### Patch Changes

- 5ffaba8: `vinaya dispatch` wires a `PreToolUse` deny rule into every claude dispatch's generated settings, refusing a Bash call with `run_in_background: true` and naming the foreground alternative. `devReviewLoop` resumes a developer that stopped without pushing (a dirty worktree or local commits ahead of the remote) once, in the foreground, before folding a still-unpushed turn into `pause{reason:'no_push'}`; a reviewer report with findings but no cited `FINDING_IDS` is sent back once before `report_uncitable` proceeds on its severities, never `no_progress`. The round cap is `reviewPolicy.maxRounds` (default 3), replacing a hardcoded constant. `evaluateReviewFindings` caps a finding located in the PR body, a comment, or a role file at `MINOR` before counting it — prose alone never blocks a merge — and `verdict-extraction`'s finding-severity read now carries each finding's location too, so the merge gate applies the identical cap. `vinaya pr report --push --body-file <path>` composes the whole body from a local source (regenerating Evidence/Tokens fresh) and writes it to the forge outright; bare `--push <n>` is unchanged.
- 63547a5: `checkDispatchReadiness` and `checkD1`/the other coherence checks now tag every blocker/failure they produce with a machine-readable class (`DispatchBlockerClass` on `DispatchResult.blockerDetails`, `CoherenceFailureCode` on `CheckFailure.code`) beside the existing human message string. `check-dispatch-readiness`'s and `check-coherence`'s `recoveryPromptFor` now switch on that class/code exhaustively (a `never`-typed default arm), so a new blocker/failure class that ships with no matching `case` fails typecheck instead of silently falling through to generic or wrong advice. `checkD1` now distinguishes `d1-self-dependency` (escalate — a self-dependency can never be closed) from `dispatched-on-unmet-deps` (an ordinary unmet dependency — close it), which previously shared the single `D1` check code and could route a self-dependency to "close the dependency."
- 7d5f119: `vinaya issue create`, `vinaya issue edit`, and `vinaya issue objectives edit` on a task Issue now render the twelve-section brief that draft body would freeze into and grade it with the same `brief-shape` gates `pr create` applies, before the write reaches the forge — a body that would freeze into a brief `pr create` refuses is now refused at the Issue instead, naming the section and the rule. Dormant for a tranche-labeled task Issue and outside a real repo checkout (no brief template, no resolvable owner/repo).
  
  `@attalabs/aeg-core` gains three new Issue-content predicates: `checkObjectivesRespectBoundary` (an Objective, Part, or Test plan line naming a path the Boundary's `Out:` clause or the Surface's `out:` list excludes is refused, quoting both lines), `checkNoForeignTaskOwnership` (a Traps/Stop-and-escalate/Boundary sentence assigning ownership of this task's own objective to another task is refused), and `checkPartsCoverageAndSequence` (an objective no Part cites, or Parts numbered out of sequence, is refused) — wired into both `vinaya issue create`/`edit`'s validated write path and this repo's own `open-issue.ts` dogfood gate.
- 75e2d46: Five doctrine defects fixed: the pre-push selector always runs test files named under a new `prePush.alwaysRun` config key plus every test file added or renamed in the diff; `rings.ring1_forgeWriteInterception`/`ring2_asyncAudits` now mean what they say (`true` runs the ring, `false` opts out — inverted from before, with a version-gated `vinaya upgrade` migration for a stale config, now bidirectional in either direction); `@attalabs/aeg-forge-state` ships two tested primitives for a bare `Depends-on`/`Conflicts-with` edge id — `requireTrancheQualifiedEdges`, which throws once a bare id could belong to more than one tranche, and `tranchesAttachedToMilestone`, which lists the distinct tranches attached to a Milestone via the forge — with the actual dispatch-gate refusal wired in by a separate task (`packages/aeg-core/bin/verify-dispatch.ts` is out of this task's Surface); the post-merge Archivist self-chains into `archive tranche`, which now appends a `### Retrospective: <slug>` section (task count, rounds per task, merged PRs) to the Milestone description once a tranche is complete; the evidence runner's per-command budget is now `report.commandTimeoutMs` (default 15 minutes, capped at 1 hour) instead of a hardcoded 30 seconds; and a closed Issue's status rules now run before `branch-exists`, so a closed NOT_PLANNED Issue with a lingering task branch reads `dropped`, never `in-flight`.
- 38f5efc: The `AEG:EVIDENCE`/`AEG:TOKENS` engine behind `vinaya pr report` moved to `apps/cli/src/lib/pr-report-engine.ts`, so a command never calls a command: `pr-report.ts` is now a thin CLI wrapper over it, and `devReviewLoop` calls the same engine function in-process once a round's head is green, rather than shelling out to `vinaya pr report --push` — the Developer's own turn now ends at the push, never running that command or posting a round comment itself. The driver dispatches both reviewers and runs its own evidence report in parallel, reads and clears a small `.vinaya-round-response` file the Developer may have written citing addressed finding ids, and posts the round marker comment (`Head: <sha>`, `<!-- aeg:developer:round-<n> -->`, the cited ids) in the Developer's place; a failed report is logged, never a pause. A reviewer's `NOT MET` objective whose evidence names only the PR body, a comment, or a role file — `isProseLocation` (now exported from `@attalabs/aeg-core`), reused from the existing body-located `MINOR` finding cap — is reclassified `MET (prose note)` before either the rendered verdict or the round's outcome ever sees it; a `NOT MET` naming a real source or test file is unaffected.
- 54c43fe: `parseIssueTestPlan` now refuses a `## Test plan` fenced command line that runs a test runner with no test-file argument — a bare `bun test`, `bun test` on a directory, any `bunx turbo test` form, or `vitest run` on a package — naming the offending line, rather than freezing a brief whose own Part re-runs the whole suite the pre-push hook and CI already cover. A line naming specific `*.test.*`/`*.spec.*` file(s), or a `vinaya check` command, still passes. `assembleAndRenderBrief`/`assembleAndRenderBriefForIssue` now surface this refusal directly instead of silently falling back to an empty Test plan.
  
  `vinaya dispatch`'s per-dispatch settings file now carries an `env` block (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, a raised `BASH_MAX_TIMEOUT_MS`) and a widened `PreToolUse` deny hook: a Bash call running a whole-suite test command, or a subagent call with its background flag set, is denied — so a dispatched session inherits this execution posture even with no operator export.
- 201fd4e: `tranchesAttachedToMilestone` now fetches Issue labels only, server-side filtered and paginated through the buffered `gh` client, instead of a single unpaginated fetch of full Issue bodies — a Milestone holding many Issues with large bodies no longer overruns the process output buffer. The `Depends-on` resolver now resolves a bare backlog Issue number through that Issue's own pull request — by its `task/issue-<n>` branch, or by a `Closes #<n>` reference in a PR body — before falling back to the Issue's own closed/open state, so a merged backlog dependency is recognized as merged and a closed-but-unmerged one is not mistaken for it.
- 16c37b4: `CheckSpec` gains `validates: 'body' | 'issue'`. `vinaya pr create`/`pr edit`/`pr report --push` and `issue create`/`issue edit` now enforce every registered check whose `validates` is `'body'`/`'issue'` through the same runner CI uses — a new check registered later needs no further wiring. Six new core checks (`issue-title-grammar`, `issue-objectives-numbering`, `issue-parts-coverage`, `issue-surface-globs`, `issue-tranche-label`, `issue-milestone-attach`) validate a task Issue's own content at write time and in the coherence sweep. `checkClosesN` is split into `checkClosesNPresence` and `checkClosesNTopology` (two functions, two names, no more collision). The generated `vinaya-checks.yml`/`vinaya-body-checks.yml` re-read a pull request's body with a bounded backoff instead of trusting a single read that can race a `pr report --push`/`pr edit` still landing. The Surface-overlap refusal exempts a shared `tests`/`specs` directory and a glob every open task in a real multi-task Milestone cohort declares. A directory-only §4 (`boundaryNarrowsSurface`) now names its covered consumers' test directories explicitly, and `checkConsumerTests` accepts a bare `tests`/`specs` directory as coverage.
- 2e4be63: The dev-review-loop and `review post` now build one `ReviewInputManifest` (head, the frozen brief's own hash, objectives version, newest ruling ordinal, and the effective review policy's digest) before dispatching reviewers, and render it into every verdict/escalation comment: `Brief hash:` and `Policy digest:` now render unconditionally, right after `Ruling ordinal:`. The merge gate (`checkReviewGate`, now accepting an optional `briefHash`) and the loop's own publication self-check both compare a verdict's echoed manifest fields to the current one through the same `compareManifest` function, so a Planner superseding the frozen brief mid-round (`'brief_superseded'`) or a policy change (`'policy_changed'`) invalidate a held verdict the same way an objectives edit or a new ruling already did. Every prior binding (head/patch-identity, objectives version, ruling ordinal) is unchanged in meaning and outcome; a comment predating this change (no `Brief hash:`/`Policy digest:` line) is grandfathered, never treated as a mismatch.
- 12420d0: Which severities block is now repository policy, not a fixed rule: `vinaya.config.json`'s new `reviewPolicy` field carries two separate thresholds, `codeReviewThreshold` (over `BLOCKER > MAJOR > MINOR`) and `securityThreshold` (over `CRITICAL > HIGH > MEDIUM > LOW`) — a finding at or above the threshold blocks. An omitted policy keeps today's behaviour (`BLOCKER`/`HIGH`); a present-but-unknown severity value refuses at config load rather than silently falling back. This repository is configured to `MAJOR`/`HIGH`.
  
  One pure evaluator (`@attalabs/aeg-core`'s new `review-policy.ts`: `evaluateCodeReview`/`evaluateSecurityReview`/`evaluateReviewFindings`) now sits behind every site that derives, accepts, or judges a verdict — `vinaya review post`'s derivation and its round-two contradiction/delta checks, the dev-review-loop's round assessment (`buildVerdictFromReport`) and its publication self-check (`publishRound`), and the merge gate (`checkReviewGate`) — so no path can apply a weaker rule than another. A reviewer's own `APPROVE`/`PASS` never overrides the evaluator: a verdict comment whose text claims clean but whose own FINDINGS block carries a finding at or above the threshold is refused before posting, refused before publication, and read as not clean by the merge gate. The gate and the loop resolve policy from the SAME source — the default branch's `vinaya.config.json` — never the PR's own checkout, so a change cannot lower its own threshold.
- 275b05f: The Vinaya Log's event envelope gains `meta.schema: 2` — stable per-event identity, an opaque per-process identifier, task/run/attempt/parent lineage, input versions (mirroring `review-input-manifest.ts`'s field set), and a trust-provenance value — alongside the unchanged `schema: 1` read shape, which every event recorded before this change keeps parsing under. `buildHeader` now builds `schema: 2` for every event going forward; none of the new fields are wired to a real producer yet (`control-store-v1`/`worker-isolation-v1` do that), so they read back `null`/`'unavailable'` honestly rather than an invented value. Six new event kinds ship typed schemas — `gate`, `operation`, `usage`, `role_attempt`, `handoff`, `effect` — and a `verdict` outcome's findings gain optional `severity_scale`, `policy_treatment`, `confidence`, `confidence_scale`, `confidence_source` fields, all additive to the pre-existing `id`/`severity`/`state` shape.
- d257b83: The developer contract states the push and the pull-request open are foreground steps; `dev-review-loop` checks this rather than trusting it. A round-1 turn that ends without a push, or without an open PR, is resumed ONCE with the exact commands before the loop ever polls — a turn that ends with no push and a posted refusal/escalation ends the loop at once instead, on the task Issue, never entering the poll. A poll that still gives up names branch, local head (if the worktree is known), remote head, and pull-request existence.
  
  Mergeability is now read from the forge before dispatching a round's reviewers and again before publishing: a conflicting head is sent back to the developer with the conflicting file(s) named (never a reviewer dispatch, never a CI wait) and, if a clean head falls into conflict while reviewers were working, that round's held verdicts are discarded and the developer is resumed to resolve. A base that moves past the driver's own code mid-run pauses the loop (`stale_driver`) rather than let it keep judging rounds against, and eventually publish against, a gate that has since changed underneath it.
  
  `vinaya task run` (and `dev-review-loop`/`dispatch`) resolve `--agent` from `dispatch.agent` in `vinaya.config.json` when the flag is omitted entirely.
- 5ef94c1: A backlog Issue with no tranche now runs like a tranche task, end to end. `vinaya task run --issue <n>`, `task brief --issue <n>`, and `dev-review-loop --issue <n>` derive a `task/issue-<n>` branch, render and freeze the same twelve-section brief from the Issue's own body, and run through the same dispatch-readiness gate (`verify-dispatch.ts --issue <n>`); `closes-n`, `surface-scope`, and `dispatch-readiness` resolve the new branch shape directly against the Issue, with `Depends-on`/`Conflicts-with` optional; `issue create`/`edit` validate a task-shaped body the same way whether or not it carries a `vinaya/tranche:*` label; and `archive` closes a backlog Issue's PR on merge the same way it closes a tranche task's.
  
  `issue objectives edit --add` now requires a `--part "Part <n> (O<k>) — <outcome>"` for the objective it adds, written into `## Parts` in the same edit; `--drop` prunes the Part lines that cited only the dropped objective.
  
  Every driver (`task run`, `dev-review-loop`) tees its own role-prefixed stream to `~/.vinaya/loops/<owner>-<repo>/<issue>.log`, appended across relaunches with a run-start marker; `vinaya task status --follow` (and `--issue <n> --follow`) tails it live. A stale driver (a base moving past this driver's own code mid-run) now re-execs itself from the updated base and reattaches to the same task, pausing only if that re-exec itself fails. `dev-review-loop --resume` accepts a head that moved since it paused — a ruling followed by a fix push is the normal case — restarting the round counter at the ruling's own ordinal and dispatching reviewers directly on the new head.
  
  On attach or resume, the loop now reconstructs the task's ENTIRE round journal — every prior round, from the already-flushed forge log and this machine's own still-unflushed outbox — rather than publishing a table that only ever showed the current process's own rounds; round numbering recovers the same way when no locally-held state survives to say where the last driver left off. Every driver path now guarantees one final outbox flush on the way out, including an uncaught error, not only a clean `pause`/`publish` return. Every prompt sent to a resumed developer session now names the task Issue, branch, worktree path, and current remote head, so a session resumed among many worktrees never has to ask which branch is meant.
- f7b3a5d: The generated review-gate workflow's no-build pre-check job now honours the `vinaya/waiver:review` label: a pull request carrying it (unverified — actor verification stays in the trusted build job, unchanged) is built and evaluated by the real gate, instead of the pre-check holding red on a verdict comment that will never arrive. The pre-check's label and verdict-marker conditions are read from `@attalabs/aeg-core`'s `WAIVER_LABEL_REVIEW`/`VERDICT_MARKER_SOURCE` (the latter now exported) at CLI-generation time, never a second hand-typed literal of either fact. `vinaya upgrade` regenerates the workflow for adopters still on the prior (verdict-only) shape; `vinaya doctor` flags it as drifted until then.
- 47604c6: `vinaya issue create`/`vinaya issue edit` (and this repo's own `open-issue.ts` PreToolUse path) refuse three more Planner mistakes before they reach the forge: a task-shaped body (carrying `## Objectives` or any Planner's-rationale field) posted with no `vinaya/tranche:*` label, naming the missing label; a Boundary rationale naming a repository path no `## Surface` `in:` glob covers, naming the path and the nearest `in:` entry; and two open task Issues in the same Milestone whose `## Surface` `in:` lists overlap with neither naming the other in `Conflicts-with`. `vinaya task dispatch`/`task brief` for a task id absent from the tranche's task list now names the title form it looked for, the label, and how many open Issues carry it.
- Updated dependencies [75e2d46]
- Updated dependencies [201fd4e]
  - @attalabs/aeg-forge-state@0.27.1
  - @attalabs/aeg-types@0.27.1

## 0.27.0

### Minor Changes

- 9fee599: `vinaya task brief` refuses to render when the checkout is behind the fetched remote default branch or dirty on a file the brief pins, naming the drift; the frozen brief's own §2 now states the source revision its pins were computed from, and the dev-review-loop's reviewer prompt names that revision as a fact. `vinaya task brief <tranche> <n> --supersede --reason <text>` appends a new, higher-versioned frozen brief comment naming its predecessor and the reason — the original is never edited or deleted, and every reader of "the frozen brief" (the loop, `check-brief-shape`) resolves the newest version via `@attalabs/aeg-core`'s new `resolveNewestFrozenBrief`.

### Patch Changes

- 047b061: A pull request with no linked Issue at or above the objectives cutover, and no `## Objectives` section of its own, is now judged the same way by every gate: `vinaya review post` renders a verdict with no objectives block and no `Objectives version:` line instead of refusing, exactly matching what `vinaya check review-gate` already accepted. `body-bare-digits` now treats `O<n>.` list-marker prefixes under a pull request's own `## Objectives` heading as structure, not prose, the same way it already does for an Issue body, so a pull request may carry its own objectives list. Both the gate and `review post` now decide a pull request's objectives source (Issue, PR body, or none) through one new exported `@attalabs/aeg-core` function, `resolveObjectivesSource`.
- a08c822: `devReviewLoop` (`@attalabs/vinaya`) now sources a task's objectives from the newest principal-authored `vinaya issue objectives edit` comment when one exists, and from the principal-authored frozen brief otherwise — never the live Issue body — with a version computed the same way the merge gate computes its own, so a loop-published verdict now carries a real `Objectives version:` line and `OBJECTIVES:` block instead of a hardcoded `null`, and passes the gate on a post-cutover task. If the objectives version changes between dispatching a round's reviewers and their verdicts coming back, the round's verdicts are discarded — never held, never published — and the loop pauses with a new `'objectives_changed'` pause reason (`@attalabs/aeg-core`) naming the old version, the new version, and the edit command that caused it.
- ef00bec: `devReviewLoop` (`@attalabs/vinaya`) now tells a review dispatch that wrote nothing apart from one that wrote an empty, clean `findings.txt`: a work directory still missing `findings.txt`, `report.txt`, or (on a task with objectives) `objectives.txt` after a fresh dispatch is retried once into a fresh work directory, and a second miss pauses the loop through a new `'infrastructure'` pause reason (`@attalabs/aeg-core`) naming the role and the missing artifact — never held or published as a verdict. The reviewer/security dispatch prompt now names `objectives.txt` whenever the task carries objectives.
- 50791c2: Every rendered verdict (`vinaya review post`, and `devReviewLoop`'s own published verdicts) now carries a `Ruling ordinal: <k>` line — `0` when the PR had no principal ruling at cast time, rendered unconditionally, never omitted the way `Objectives version:` is pre-cutover — read from its own first-seven-line window by the shared extractors. `checkReviewGate` (`@attalabs/aeg-core`) treats a verdict as clean only when its ruling ordinal covers the PR's current newest one, naming the newer ruling when it doesn't: a `vinaya pr rule` ruling posted after approval now turns the merge gate red until reviewers re-cast against it. If a ruling lands between a `dev-review-loop` round's reviewer dispatch and its verdicts coming back, the round's verdicts are discarded — never held, never published — and the loop pauses with a new `'ruling_posted'` pause reason (`@attalabs/aeg-core`) naming the old ordinal, the new ordinal, and the ruling's marker identifier.
- 5435bb8: `vinaya issue create` and `vinaya issue edit` now refuse a task Issue whose `## Surface` `out:` list excludes a document `.vinaya/doc-owners` binds to a path its `in:` list covers, naming the binding and the two contradicting lines — the same predicate also runs as coherence check R2 over open task Issues, so an Issue written before this gate is reported instead of silently failing at the Developer's first commit.
- Updated dependencies [6266fea]
  - @attalabs/aeg-forge-state@0.27.0
  - @attalabs/aeg-types@0.27.0

## 0.26.0

### Minor Changes

- 252d2c8: `vinaya task dispatch` posts and reads the dispatched brief on the task's real forge Issue, not on an Issue whose number happens to equal the task id — fixes a bug where a task id that was itself a valid, unrelated Issue number (e.g. task 3) could post the brief on that unrelated Issue instead.
  
  A task branch created by a brief's Step 0 (`git worktree add ... --no-track origin/main`, then `git config push.autoSetupRemote true`) no longer tracks the branch it was cut from — a plain `git push` now reaches the task's own remote ref instead of failing with an upstream-name-mismatch error that suggests pushing onto the default branch.
  
  A rendered brief's §4 Technical surface map and premise pins now name only the files the Planner's Boundary rationale actually calls out, resolved against the tracked tree, instead of every file under the task's declared `## Surface` directory globs — a task touching a dozen files in a large directory no longer renders a brief instructing hundreds of unrelated modifications. `vinaya brief render` no longer requires `--surfaces`; omitted, it derives the surface from the Issue's own `## Surface` section, the same source `vinaya task dispatch` already reads.
- d4ab022: `vinaya issue create`/`vinaya issue edit` now refuse a task Issue whose `## Surface` `in:` glob matches no tracked file (naming the glob), whose `## Parts` cite an `O<n>` the Issue's own `## Objectives` never defines (naming the part and the citation), and whose "Docs to keep coherent" field names a path outside its own `## Surface` `in:` globs or inside its `out:` globs (naming the pointer and the excluding glob). The Surface-glob resolution predicate is injected from the caller (`forge-write.ts`'s `expandGlob`) — the same implementation `brief-assembly.ts`'s render path already uses — so the authoring gate and the brief renderer can never disagree about whether a glob resolves.
  
  For a task Issue at or above the brief-sections cutover (`BRIEF_SECTIONS_SINCE_ISSUE`), `checkBlastRadiusScope` now decides an under-declared blast radius from the `## Surface` `in:` glob list alone, never from a prose scan of the rationale — naming a shared package in order to explicitly exclude it can no longer trip the gate. Below the cutover, the original prose scan is unchanged.
  
  A dot-prefixed directory (`.claude`, `.github`) is now usable in a `## Surface` glob: the file-path heuristic no longer misreads a dot-directory's leading dot as a file extension.
- 529fa54: The Brief Author role is retired: the brief is dispatched by the Planner, not authored by a separate role. `author-the-brief` (`ACTIONS`) is now `performedBy: ['planner']`. The `needs-brief-correction` label keeps its id — Issues in flight carry it — but its copy now names the Planner. `vinaya doctrine --role brief-author` refuses, pointing the caller at `--role planner`, even while `aeg-root/roles/brief-author.md` still exists on disk. `vinaya upgrade` now removes a generated `.agents/skills/vinaya-<role>/SKILL.md` for a role this codebase has retired, and no longer generates one. Retirement is DECLARED (`RETIRED_ROLE_NAMES`), never inferred from a role file's absence — `aeg-root/roles/brief-author.md` deliberately outlives this change, so an emitter that read the file as proof of liveness would both skip the cleanup and keep writing a skill whose embedded `vinaya doctrine --role brief-author` this same release refuses. `eject` is unchanged.
  
  `AEG_BRIEF_V1_MARKER` and `contentAfterTwoLines` are promoted into `@attalabs/aeg-core`'s exports — the single implementation `packages/aeg-core/bin/verify-brief.ts`, `verify-dispatch.ts`, `archive-task.ts` and `apps/cli`'s `dispatch-task.ts`/`check-brief-shape.ts` all now share, replacing four independent copies. `brief-author` is removed from `@attalabs/aeg-core`'s `ROLE_VALUES`, the log schema's dispatchable-role union, so a log line claiming that role no longer validates. `verify-brief.ts` now grades the task Issue's frozen `aeg:brief:v1` comment on a task branch — the same body `vinaya check brief-shape` already grades since the brief was moved off the PR body — instead of `PR_BODY`, so the authoring-time gate and the CI gate cannot disagree about a post-split brief.

### Patch Changes

- 7e260fd: `checkDocsWithinSurface` no longer refuses a "Docs to keep coherent" pointer for sitting outside every `## Surface` `in:` glob. The pull-request-time gate this check anticipates (`checkSurfaceScope`) only ever refuses a changed file against `out:` and never consults `in:`, so that branch enforced a premise nothing downstream shared — it only forced a Planner to widen a surface around a single doc pointer. A pointer that falls inside an `out:` glob is still refused by name.
- a6dbfb5: Registers `pr-premise-reassert` in `CLI_CHECK_RING` (`@attalabs/aeg-core`), the mirror table every `apps/cli` check bin needs an entry in. The check itself, shipped in `@attalabs/vinaya`, re-asserts a pull request body's `Premise:` pins against the real tree whenever the block is present — no branch-name condition — so a pin the pull request's own diff falsifies fails instead of merging as decoration.
- Updated dependencies [529fa54]
  - @attalabs/aeg-forge-state@0.26.0
  - @attalabs/aeg-types@0.26.0

## 0.25.0

### Minor Changes

- f2a20f8: A task Issue body now carries four more sections under the Planner's rationale — `## Surface` (directory-level `in:`/`out:` glob lists), `## Parts` (numbered `Part <k> (O<n>[, O<m>]) — <outcome>` lines), `## Test plan` (the `unit-tests-only` sentinel or a fenced command list), and `## Stop conditions` (a bullet list) — each parsed by its own function in `@attalabs/aeg-core` (`parseIssueSurface`, `parseIssueParts`, `parseIssueTestPlan`, `parseIssueStopConditions`), and composed into one gate, `checkIssueBriefSections`. A task Issue numbered at or above `BRIEF_SECTIONS_SINCE_ISSUE` is refused, naming the missing/malformed section, when any of the four is absent; below the cutover an Issue passes unconditionally, and a null Issue number fails closed.
  
  `vinaya brief render` now fills a rendered brief's §4 Out of surface, §6 Numbered parts, §9 Test Plan, and §10 Stop conditions directly from these four parsed sections instead of a hand-authored placeholder, and refuses — naming the section — when one cannot be derived. A rendered brief needs no hand edit to pass `verify-brief`/`brief-shape`.
- 8825319: New `src/dev-review-loop/` module: `assessRound(state, observations)` — the developer review loop's policy half, pure and I/O-free — decides every transition (dispatch the developer, dispatch reviewers, ask for confidence, publish, or pause with a reason) and returns the `DevReviewLoopEvent`s for the caller to pass to the injected `log()`. The four exits (a confidence collapse after one extra developer turn, rounds over three, a finding id previously resolved reported again, two consecutive rounds resolving no id) are decided here and nowhere else, each an explicit `stop_condition_met` line. `renderSummary(journal)` renders the publication comment: one table, counts by severity per round, developer confidence, and outcome — no finding text, no line either verdict extractor would read as a real verdict.
  
  `stop_condition_met.condition` widens additively with `'confidence'` and `'reappearance'` so a reader tells a confidence collapse and a finding reappearance apart from each other and from a generic stall, instead of collapsing all three onto `no_progress`.
  
  `review-status.ts`'s `findingStates` and `groupRounds` (plus the `Round`/`VerdictComment` types they use) are now exported — no behavior change — so `assessRound` reuses the same id-state merge semantics rather than a second copy of the rule.
- c70b5b0: A doctrine sentence or source comment that states what code does now binds to the source that proves it. `packages/aeg-core/src/doc-claim.ts` parses an `AEG:CLAIM` marker — an HTML comment in markdown, a `//` or `*` comment line in TypeScript — carrying the premise-pin grammar (`<path> contains:<literal>`, `absent:`, `sha256:`) already used by a brief's `Premise:` block, and re-asserts each pin through the same `checkPremises` predicate. `verify-docs` runs it as C8: blocking in `--pr` mode over the doctrine and product files the diff touched, repo-wide in full mode. Markers inside fenced code blocks are documentation, not claims, and are never evaluated; a marker cannot satisfy itself, because marker lines are stripped from the cited content before a `contains`/`absent` pin is evaluated.
  
  Every statement of the verdict-extraction read window across the repository is bound accordingly, and `pr rule`'s source comment — which still described a three-line window after the window widened to five — is corrected.
  
  `vinaya review post` now refuses a `doc-correctness` finding whose description carries no `Search:` pattern, or whose pattern carries a path filter. The findings-file grammar is unchanged — this is a content rule on the existing description field — and a pattern reaching for `|` alternation now gets an error naming the pipe-delimiter conflict instead of a bare field count.
- 8a26dc3: Adds the `forge_write` family to the Vinaya Log schema (`ForgeOpSchema`, `ForgeWriteEventSchema`, `LogEventSchema` widened to a three-way union) and `vinaya log flush --issue <n> | --pr <n>`, which posts a target's outbox as one or more marked comments (`<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->`), logs its own `forge_write` line before truncating, and truncates only the lines the forge confirmed.
- 5f529b1: A code-review or security verdict now carries the objectives it was judged against. `vinaya review post` renders an `OBJECTIVES:` block — one `O<n>: MET | NOT MET — <evidence>` line per objective, via `--objectives-file` — after `SPEC CONFORMANCE:`/before `CONFIG SCAN:`, and an `Objectives version:` line (a stable hash of the resolved list) at the verdict's fixed head; it is required whenever the closed Issue (or the PR body's own `## Objectives`) has a list to judge, refuses an id mismatch, refuses a clean verdict (`APPROVE`/`PASS`) alongside any `NOT MET`, and a re-review must restate every prior objective. An Issue below `OBJECTIVES_SINCE_ISSUE` renders neither line at all.
  
  `@attalabs/aeg-core`'s `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` now read a comment's first FIVE lines (widened from three) and return `objectivesVersion`; `checkReviewGate` treats a verdict as clean only when both its judged head and its objectives version match the PR's current ones — a push OR an objectives edit voids the verdict, a body edit alone changes nothing the gate reads. `deriveReviewStatus` gains a matching `objectives-moved` pause reason.
- 112613a: A task Issue now carries a `## Objectives` section — numbered `O<n>. <sentence>` lines, one observable outcome each. `objectivesOf`/`objectivesVersion`/`renderObjectives` (`@attalabs/aeg-core`'s new `objectives.ts`) are the one parser and version hash every later consumer reads.
  
  `vinaya issue create`/`vinaya issue edit` refuse a task Issue without one (`checkIssueObjectives`, wired through the new `objectives` `briefSchema` builtin), and `vinaya check coherence`'s R1 grades the same rule against the live stock — both for Issues numbered `OBJECTIVES_SINCE_ISSUE` (404) and above, so the pre-gate stock stays green.
  
  On the brief side, `verify-brief`/`vinaya check brief-shape` now refuse a brief whose `## Objectives` section doesn't match its Closes-linked Issue's (`checkObjectivesCopy`), or whose numbered Parts don't cite every objective and vice versa (`checkObjectivesCoverage`). `vinaya brief render` copies the Issue's Objectives section into the rendered brief between the header and §2.
- 9237f92: `reader-resolvable-prose`'s `checkUnresolvableReferences` gains a fourth `ProseFileClass`, `product` — a tranche-slug citation under the new exported `PRODUCT_SLUG_SCOPE` (CLI source, the CLI and sources READMEs, the workflows, `.vinaya`) is a `blocking: true` finding, where every other class stays `blocking: false`. `check-reader-resolvable-prose.ts` sweeps that scope alongside the doctrine tree, prints a blocking finding as `severity: 'error'`, and exits `1` if any reportable finding is blocking — the check still exits `0` for every other class. It runs at the pre-push hook (already `scope: 'full'`, so already in `--local`'s sweep) and, blocking, in CI.
  
  `retired-vocabulary.test.ts` no longer greps `apps/cli/src`/`.github/workflows`/`.vinaya`/the two product READMEs for a tranche-slug citation — that scope, and the pattern itself, moved entirely to `reader-resolvable-prose.ts`'s `PRODUCT_SLUG_SCOPE`, closing the gap where a change to one package's files could pass the push hook through another package's cached test result (a CLI-only diff never marked `aeg-core` affected).
- ba2ac11: `vinaya task dispatch <tranche> <n> [--agent claude | codex | gemini]` renders a task's brief from its Issue and the tree, pins the premises, and posts it once as a frozen `aeg:brief:v1` Issue comment — refusing outright, naming the existing comment's URL, if the Issue already carries one. With `--agent`, it starts the Developer through `dispatchRole` when that function is available, else prints the rendered brief and the manual dispatch instruction.
  
  `vinaya pr create` no longer splits a brief section out of the PR body or posts it as a second comment — the brief now lives exclusively on the task Issue, posted by `task dispatch` before the Developer ever starts. A body still carrying either legacy `aeg:brief:start`/`aeg:brief:end` marker is refused outright. The PR body template's `## Summary` section is renamed `## Decisions` — one line per choice the brief left open, never a restatement of what the diff does — and its `## Reference — the dispatched brief` section is removed entirely.
  
  Every reader that previously read the brief out of the PR body now reads the Issue's `aeg:brief:v1` comment instead on a task branch: `verify-dispatch --premise` (with no file argument), `check-brief-shape`, and the post-merge Archivist's provenance assembly (whose `- Brief:` line now names the comment's URL). A standalone `fix/*` branch's brief is unaffected — it still lives directly in its own PR body.
- b8a540c: `log(e)` exists: a typed event validated by one zod schema (`@attalabs/aeg-core`'s new `log/` — `LogEventSchema`, `buildHeader`, `redact`), written by one hardened sink (`apps/cli/src/lib/log-sink.ts`) to a per-task ndjson outbox under `~/.vinaya/outbox/<owner>-<repo>/<issue-or-none>.ndjson`. The header (`meta`/`subject`) is filled from the environment, the origin remote, the package version and the doctrine tree in force — never self-declared by a caller. Two families ship: `dispatch` (`dispatched`, `outcome_received`, `dispatch_failed`) and `dev_review_loop`'s ten events; the other four families named in the Vinaya Log spec are out of scope here.
  
  `log()` never throws and has zero real callers yet — `dispatchRole` and `devReviewLoop` land in a later task, proved by a test that fails on the first caller outside that pair. See `apps/cli/specs/log.md`.

### Patch Changes

- @attalabs/aeg-forge-state@0.25.0
  - @attalabs/aeg-types@0.25.0

## 0.24.1

### Patch Changes

- dfbaa8e: Three more fixes found live fixing PR `#417`'s own test flakiness: `apps/cli`'s `test` script now passes `--timeout=30000` (a root `bunfig.toml` `[test]` timeout alone does not work on this bun version — verified, not assumed); the generated pre-push hook runs the affected test suite at `--concurrency=1` so a machine already busy with other work doesn't push a git-clone-heavy fixture test past its timeout, while CI's dedicated runner keeps turbo's default concurrency; and `aeg-root/roles/developer.md` plus the rendered brief's §6/§8 no longer tell the Developer to manually run the affected suite per Part now that the pre-push hook enforces it on the one push.
- @attalabs/aeg-forge-state@0.24.1
  - @attalabs/aeg-types@0.24.1

## 0.24.0

### Minor Changes

- d79cf8e: `brief-shape` gains four new refusals (task 9's "no unpinned code claim, no scripted doctrine" rule, made mechanical — Issue #385): a bare `<path>.<ext>:<digits>` code-fact reference outside a `Premise:` pin and outside a fenced code block; a `§5`/`§6` fenced command block (`export`/`bun`/`gh`/`git`/`grep`/`sed`/`cat`/`diff`/`vinaya`) with no fenced output block after it (the Step `0` `git worktree add` block is exempt); a `§4` naming a path under `packages/<pkg>/` with no named consumer test path or `consumer-tests: none — <reason>` sentinel for a workspace package depending on `@attalabs/<pkg>`; and a `§4` naming a check or a forge-writing command with no `Defeat cases:` line in `§6`. A new check, `doctrine-no-procedures`, refuses a fenced block in `aeg-root/**/*.md` (or an adopter's configured `doctrineRoot`) carrying two or more shell-command lines — a runbook, not an illustration — exempting the `AEG:VENDOR-EXAMPLE` anchor pair and any `templates/` file; unlike its report-only sibling `doctrine-portability`, this check blocks (`severity: error`, exit `1`) since it ships with an expected-zero corpus.
- c0eb05c: `vinaya brief render <tranche> <n> --surfaces <glob,...>` (task 12, #387) emits the twelve-section brief skeleton from the task Issue and the tree, with every mechanically-derivable section filled — the header, Step `0`, the dispatch-gate pre-flight line, `§4`'s file list (consumer packages, a `sha256` premise pin per file), `§7` from the doc-owners derivation, and every remaining section from the Issue's eight-field Planner rationale — refusing, naming the missing fact, when a derived section cannot be derived.
  
  The Test Plan's `[agent]` half stops being a checkbox: `brief render` emits it as a fenced command list, and `vinaya pr report` now runs every line from the PR head and writes the command plus its actual output into a third `AEG:EVIDENCE` group — `check-evidence-fresh` recomputes it exactly, the same way it already does Group A. `test-plan` grades `[principal]` boxes only; `brief-shape` refuses a checkbox `- [ ] **[agent]**` item on a PR at or above a new rollout constant.
  
  `vinaya pr create` now runs every registry check declaring `PR_BODY` over the body before it reaches the forge, so a body that opens is a body CI's own checks would pass too — skipped when `rings.ring1_forgeWriteInterception` is on.
  
  The brief/report split and `vinaya brief render` are unchanged; the refreeze and frozen-body behaviour this changeset described was removed before release by PR #400 and never shipped.
  
  The five doctrine sweeps (`reader-resolvable-prose`, `retired-vocabulary`, `doctrine-portability`, `doctrine-no-procedures`, `workspace-escape`) now declare `include: ['aeg-root/**/*.md']`.
- f6b1d26: Every fact the review loop needs is a command output on the forge rather than a sentence somebody wrote.
  
  `aggregateTaskTokenRows` now takes a principal allowlist and reads a comment's `Tokens:` line only when an allowlisted author posted it — every agent in this model posts under the Principal's own forge identity, so an unfiltered read counted a stranger's pasted table as a real turn. `TokenSourcePr.comments` carries `{ body, author }` accordingly.
  
  New: `deriveReviewStatus`/`parseDeveloperRoundMarker` (`@attalabs/aeg-core`) and `vinaya review status <pr>`, which prints `CONTINUE` or `PAUSE: <reason>[ <id>]` for the loop's state — `reappearance`, `zero-deaths`, `stale`, `max-rounds` — plus a `behind main by <n> — merge first` line when the branch is behind its base, and exits non-zero unless the loop is converging at a branch that is not behind. Rounds are derived from the PR's own verdict comments through the same extractors the merge gate blocks on.
  
  `evaluateTestPlanGate` takes optional evidence: a ticked `[agent]` item on a PR with no Developer round comment from an allowlisted author now fails carrying the new `pending` field — "has not happened yet", not "is wrong" — and names the round comment as the remedy instead of telling anyone to paste evidence into a frozen body. `CheckError` gains `pending?: true` for the same distinction.
  
  `checkReviewGate` takes an optional `patchIdOf` and binds a verdict to the PR's patch identity as well as its head sha, so a merge from the main branch or a rebase that leaves the patch untouched no longer voids a review that already read exactly those changes. Fails closed on every uncertainty.
  
  New check `exec-bits` (ring `0`): a changed file under a `checks/bin/` directory, or beginning with a shebang, must be staged `100755` — read from git's index, never the working tree.
  
  Also: the four report-only doctrine sweeps are line-scoped under a resolvable diff, so they report only findings this diff caused; `vinaya doctrine` run from source resolves the repo root's own `aeg-root/` and ignores the git-ignored package-relative bundle, and accepts `--role code-reviewer` as an alias for `reviewer`.
- 6408682: Removes the PR-body freeze (Issue #399): `pr-body-frozen` (the CI check), `vinaya pr refreeze`, and the `aeg:body-hash` marker `pr create` posted at open are all gone — `packages/aeg-core/src/pr-body-frozen.ts` and its exports (`authoredRegionHash`, `renderBodyHashMarker`, `checkPrBodyFrozen`, `FROZEN_BODY_SINCE_PR`, `BODY_HASH_MARKER_PATTERN`) are deleted with their last caller. The rule that survives from before the freeze: a review verdict binds to the head it judged, and a push after it voids it — `vinaya review status` now prints `push after verdict — re-review required`. `.github/workflows/vinaya-checks.yml` and `vinaya-body-checks.yml` fetch `PR_BODY` live via `gh pr view "$PR_NUMBER" --json body --jq .body` instead of the `pull_request` event payload, so a rerun always reads the current body. `vinaya-review.yml` gains a `workflow_run` trigger on this repo's own `CI` workflow: when CI turns green, the review gate re-runs itself for that head with the same `gh run rerun` lookup `vinaya-review-verdict.yml`'s verdict-comment retrigger already uses — no hand `gh run rerun` needed. The two `vinaya demo break` real-hook tests (`demo.test.ts`, `quickstart.test.ts`) now hold a filesystem lock around their real-subprocess assertions so they never run concurrently with each other. The pending, unreleased `.changeset/pr-body-frozen.md` is deleted along with it — that changeset described the feature this one removes, and it never shipped.

### Patch Changes

- c7fb1c4: Post-tranche hygiene (Issue #397), nine independent fixes measured on task 12's own two-hour turn: (1) the Developer commits per Part and pushes once, running `bunx turbo test --affected` per Part rather than the full suite locally — CI runs the full suite on the one push; (2) `pre-commit` was already diff-scoped, confirmed rather than re-fixed; (3) `vinaya upgrade` now retrofits the Claude Code Stop hook onto a repo that ran `init` before the hook existed, the root cause of PR #396's blank `—/—/—` token rows; (4) `vinaya pr create` splits the pasted reference brief out of the PR body and posts it as its own `aeg:brief` comment — PR #396's body was 47 KB, 37 KB of it the brief copy; (5) `pr report`'s Group C keeps each command's last 600 characters (was 4000) with the pass/fail status first, so a truncated block never buries it; (6) `vinaya review post --print-only` renders and self-checks a comment without posting, closing #184; (7) `vinaya review status` names a push after the newest verdict as `push after verdict — re-review required`; (8) a `review-post.test.ts` assertion that item 6 made stale is fixed, confirmed clean across a fresh ten-run sweep; (9) `pr report --push` executing a PR's own §9 commands on the machine running it is documented as an accepted risk rather than gated on an author check.
- f100d0b: A review verdict now binds to the branch's true head — `vinaya review post` and the `review-gate` check resolve the head via `git ls-remote origin refs/heads/<branch>` (falling back to the forge's own ref API), cross-checking `gh pr view`'s `headRefOid` only to log a disagreement, since that field can lag a push. Three comments describing the edge grammar by a bare-inline-code-span mechanism Issue `#347` removed now describe the labelled `Depends-on:`/`Conflicts-with:` span rule `parseRationaleDeps` actually implements. `enforcement.md` files the raw-API forge-write row under Ring `1`, not Ring `0`, and reworks the dead-branch-push hook's ring-2 backstop language to report-only audit, agreeing with its `NON_GATE_BINS` classification. `review-gate` no longer treats a `skipped`/`neutral` mechanical check-run as a failure, and the required review workflow's CI-green retrigger job moves to its own `vinaya-review-retrigger.yml` (triggered only by `workflow_run`) so it never reports a `skipped` check-run against the required workflow's own head — together closing the bug that blocked every PR opened since `#400`.
- be6c61d: `verdict-extraction.ts`'s `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` now read the `VERDICT:`/`Judged head:` markers from a comment's first three lines only, never anywhere else in the body. Every render this package's own callers produce puts `VERDICT:`/`ESCALATE:` on line 1 and `Judged head:` on line 3; no caller-supplied field (a finding, conformance prose, a summary) ever renders before line 5. This closes the caller-controlled-text injection class the `#392` review round found, at the source rather than at every call site: `vinaya review post` (`@attalabs/vinaya`) drops its entire per-field guard layer (`fieldsContainingVerdict`, the newline guard, and every call site) in favor of one pre-post check, `checkRenderedComment`, that runs both extractors over the exact rendered text before any `gh` write call and refuses (exit `2`) unless exactly the intended verdict extracts and the other role extracts none — for an escalation, both must extract none. `verifyPostedCodeReview`/`verifyPostedSecurity` gain the same cross-role assertion on the post-fetch path. `deriveCodeReviewVerdict`/`deriveSecurityVerdict` now skip a finding whose re-review state is `resolved` when deciding the verdict — it keeps its severity for the record but never blocks. `--scope-evidence-file` is new: a fenced block rendered directly below the verdict block, safe as free multi-line text now that extraction is windowed. `computeChangedRanges` now resolves the round-two delta against the PR's actual resolved head (fetched from `origin` by sha first) rather than the local worktree's implicit `HEAD`, refusing by name if either end of the diff isn't resolvable.
- 539e3f0: `vinaya release` runs this repo's own publish sequence in one command — five ordered preconditions (default branch, clean tree, HEAD at `origin/<default>`, a Version Packages commit unless `--allow-any-commit`, `npm whoami`), then streams `bun install --frozen-lockfile`, `bun run build`, `bun run changeset:publish`, and `git push origin --tags`, printing each published package's registry version afterward. `--dry-run` stops after the preconditions and prints the plan.
  
  `checkMainBranchRefusal` (`@attalabs/aeg-core`) now takes an optional `pushRefs` fact — git's own pre-push stdin, forwarded by the generated pre-push hook as `VINAYA_PUSH_REFS` — so a tag-only push (`git push origin --tags`) passes `main-branch-refusal` from the default branch instead of being refused alongside an ordinary commit or branch push.
- Updated dependencies [b8e3aaa]
  - @attalabs/aeg-forge-state@0.24.0
  - @attalabs/aeg-types@0.24.0

## 0.23.0

### Minor Changes

- 12b7e33: **Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `mechanicalChecks: MechanicalCheckStatus[]` field — every check-run reported for the PR's current head, excluding the caller's own review-gate check-run. A caller that does not supply it no longer compiles, the same required-not-optional discipline `headSha` already established (#73): an optional field that silently skipped the mechanical-check requirement on absence would fail open. `checkReviewGate` now also requires every reported mechanical check to be green (`bucket === 'pass'`) — an empty array does not count as clean, since there is no proof to point to. A red or absent mechanical check fails the gate the same way an unclean or unbound verdict does, naming which check is not green, or that none have reported yet. The `vinaya/waiver:review` label still short-circuits to pass unconditionally, regardless of mechanical-check state. Both `apps/cli/src/checks/bin/check-review-gate.ts` and `packages/aeg-core/bin/verify-review-gate.ts` now fetch check-run status via `gh pr checks --json name,bucket`, filtering out their own review-gate check-run name before calling in — that exclusion lives in the CLI shims, not in `aeg-core`'s pure logic, since `aeg-core` ships to every adopter under a different workflow name.

### Patch Changes

- dc803fb: Shipped doctrine now names one AI vendor by product name in exactly one fenced, clearly-labeled place (`tranche-model.md` §12's collection-adapter example) — everywhere else it refers to the coding agent's host generically. `checkDoctrinePortability` (`doctrine-portability.ts`) gains a second, additive finding kind, `'vendor-name'`: a fixed word list (Claude, Claude Code, Anthropic, GPT, ChatGPT, OpenAI, Gemini, Codex, Grok, DeepSeek, Opus, Sonnet, Haiku — company/product names and model-tier names alike) scanned against doctrine prose outside code spans and outside a new `<!-- AEG:VENDOR-EXAMPLE:START -->` / `<!-- AEG:VENDOR-EXAMPLE:END -->` fence, so the rule no longer depends on a reviewer noticing. The original path-shape predicate (`'path'` findings) is unchanged.
- e579bec: A parsed `depends-on` edge that points back at its own task is now refused as an INTERNAL parser-bug error instead of being reported as an unmerged dependency. A self-dependency is unsatisfiable by construction, so it can never be a real gate state — its presence means the edge text or the rationale parser produced something impossible. The previous wording (`whose PR is not merged yet — not dispatchable, it serializes behind it`) read as an ordinary, legitimate serialization, which invited readers to route around the gate rather than escalate it. `checkDispatchReadiness` (`dispatch-gate.ts`) gains the guard ahead of its unresolvable-edge branch, so a self-reference that also failed to resolve is still named as a parser bug rather than as bad edge text; `checkD1` (`coherence-checks.ts`) refuses the same shape the same way. Both match on either the edge's resolved Issue number or its bare task id. Legitimate unmerged and unresolvable edges keep their existing messages unchanged.
- Updated dependencies [12b7e33]
  - @attalabs/aeg-forge-state@0.23.0
  - @attalabs/aeg-types@0.23.0

## 0.22.0

### Patch Changes

- 36d69e7: Harden the transcript-pointer read every `resolveMeteringCapability` caller shares — `vinaya tokens`, `doctor`, and `quickstart` no longer follow a symlink, hang on a FIFO, or trust a file owned by another local user at the predictable `$TMPDIR` pointer path, mirroring the write-side CWE-59 hardening already shipped for this path. Also neutralizes a `|` in an attacker-controlled `model` field in the `Tokens: …` line output, matching the escaping the markdown table row renderer already applied.
- 089517a: Fix a transcript-pointer key collision: two project directories whose paths differed only in non-alphanumeric characters (e.g. `/a/b` and `/a-b`) collapsed to the same `$TMPDIR` pointer filename, so a pointer legitimately written by a session in one project could be read by an unrelated project as its own — reaching `resolveMeteringCapability`'s `pointer-unusable` reason, which refuses a commit. The pointer key now appends a full SHA-256 digest of the untouched project directory, which is collision-resistant rather than merely less likely to collide. Reads fall back to the pre-fix (legacy) pointer name when the new one is absent, so no pointer the shipped `track-transcript.sh` Stop hook already wrote on disk is orphaned by this change.
- @attalabs/aeg-forge-state@0.22.0
  - @attalabs/aeg-types@0.22.0

## 0.21.0

### Minor Changes

- a97e483: New core check: `quoted-command` (report-only). A doc that quotes a command or config line verbatim, in backticks, as a statement of present fact can now opt that span in with an `AEG:QUOTES-FILE` citation marker naming the file it quotes; the check re-verifies the quoted text still appears there. Marker-based only — no inference, no heuristic fallback for an unmarked command-looking span, since that is the exact false-positive shape that gets a gate disabled. Findings print at `warning` severity and the check's own exit code always stays `0`, so installing it cannot newly redden an existing repo's CI.
  
  The pure evaluator (`findCitedQuotes`/`evaluateCitedQuotes`) ships from `@attalabs/aeg-core`; the check bin and registration ship from `@attalabs/vinaya`.
- b0e8078: New `token-collection-wired` core check (ring 0, part of the managed `pre-commit`/`pre-push` hooks' `vinaya check --all --local`): when the token-metering probe (`resolveMeteringCapability`, `@attalabs/aeg-core`) finds a wiring point resolved — a transcript pointer that names a path — but cannot reach what it names, the commit is refused with the wiring named. A host never wired to meter at all (no pointer, no `--transcript`) passes unchanged: that is the sanctioned operator-metered case, not a defect.
  
  Local and offline only: no PR body is read (none exists yet at pre-commit) and no network call is made.
  
  `@attalabs/aeg-core` gains a new export, `isTokenCollectionWiringBroken` — the pass/fail predicate above, factored out contract-agnostic so both the shipped check and the shipped check consume the same fact. Additive on the exported surface.

### Patch Changes

- 64a85ca: `verify-dispatch`'s dispatch-readiness gate (and the shipped `vinaya check dispatch-readiness` / `vinaya check first-push-dispatch` adapters) now resolve the documented cross-tranche `Depends-on`/`Conflicts-with` form with a bare task id (`<slug> <n>`) — previously it parsed as valid, resolved to nothing, and blocked forever with a message claiming the dependency was "not merged yet" even after it had genuinely merged (#196). An edge that still cannot be resolved (unknown slug, or unknown task id within a known slug) now reports `UNRESOLVABLE`, quoting the edge text, instead of the misleading "not merged" claim — still blocking (the conservative default is unchanged), just honest about why.
- 21ccea4: `vinaya issue create` now auto-attaches a new task Issue to its tranche's open Milestone — a `resolveMilestoneAttachTarget` resolver (`@attalabs/aeg-forge-state`) matches the legacy exact-slug-titled Milestone or, new, an intent-declared one (`### Tranche intents`), and always hands `gh` the Milestone's own TITLE rather than the slug. Explicit `--milestone` on argv still wins; no matching open Milestone silently skips attach rather than failing the create. Fixes the gap where the only documented path (`milestone create` then `issue create` per task) left every task Issue labeled but never attached, and fixes the pre-existing `open-issue.ts` auto-attach, which crashed intent-declared-tranche creates by handing `gh` a slug no Milestone was titled.
- aaa21c3: `verify-registry.ts --scaffold` now classifies `apps/cli/src/checks/bin/*.ts` candidates, not just `packages/aeg-core/bin/*.ts`, `.husky/*`, and `.claude/hooks/*.sh` — the location most core check bins actually live in. A registered check's bin there now gets a correctly-ringed stub row via the new `CLI_CHECK_RING` mirror table (`@attalabs/aeg-core`), the same no-guess-unless-derivable discipline `GATE_AUDIENCE` already applies to the other prefix. Hand-authoring an `enforcement.md` row, or relocating a check's implementation across packages, is no longer necessary just to satisfy the classifier's glob.
- b0e8078: `token-collection-wired` gated on the wrong condition in both directions.
  
  `resolveMeteringCapability` returned `no-transcript-resolved` for four distinct
  situations, and the predicate treated all four as "nothing was ever wired, pass".
  Only one of them is: a pointer file that exists but is unreadable, malformed, or
  stale for this session is wiring that resolved and could not be reached — exactly
  the state the check exists to refuse — and all three passed silently.
  
  The opposite failure was reachable too: a plain human terminal, with no
  `CLAUDE_CODE_SESSION_ID` to cross-check against, holding an earlier session's
  leftover pointer in a shared `TMPDIR`, had its commits refused.
  
  Both now turn on one condition — whether the pointer can be **corroborated** as
  this session's. A new `pointer-unusable` reason distinguishes a broken pointer
  from an absent one, and any incapable verdict on an uncorroborated pointer
  degrades to the sanctioned operator-metered case rather than gating a commit.
- b0e8078: `token-collection-wired` review follow-ups.
  
  The pointer file sits at a fully predictable path in a directory other local
  users can usually write to, and this check is what makes it read automatically,
  unattended, on every commit and push in every adopter. The read is now
  `lstat`-guarded: a symlink, a non-regular file, or a file owned by another user
  is treated as no pointer at all rather than followed. The repo had already
  accepted this threat model on the writer side — `claude-stop-hook-emitter.ts`
  records a prior review's CWE-59 finding and hardens the write — and the read side
  had inherited the threat with none of the hardening.
  
  The second `packages/aeg-core/bin/check-token-collection-wired.ts` gate is
  removed. It shipped to nobody (`aeg-core`'s `files` is `["src", …]`) and existed
  only so the registry scaffold's classifier had a candidate, which made the
  doctrine row cite a path no adopter has. The row now cites the shipped
  `apps/cli` check directly, as `main-branch-refusal`'s row does. Whether the
  predicate itself should also move out of `aeg-core` now that the scaffold
  argument for keeping it there is gone is a separate, still-open question
  (issue #307) — not decided or settled by this change.
  
  `isTokenCollectionWiringBroken` briefly became a type predicate in this branch
  and was reverted before release: as a predicate it was unsound, since `false`
  also covers the sanctioned incapable case, so the negative branch narrowed to
  `capable: true` and a `.summary` dereference compiled clean while throwing at
  runtime. It ships as a plain boolean. Recorded here because these notes are the
  published changelog and a reader must not be told a predicate exists.
- b0e8078: A transcript pointer written with an empty session id no longer refuses every
  commit.
  
  The shipped Stop hook writes `(hook.session_id || "") + "\t" + transcript_path`,
  so a Stop payload carrying no `session_id` produces a pointer whose first
  character is a tab. `resolveMeteringCapability` read it with `.trim()`, which ate
  that leading tab; the subsequent `split('\t')` found no separator and classified
  the pointer malformed. A pointer naming a present, readable, summarizable
  transcript therefore refused every commit on a host that meters perfectly — the
  expensive false-positive class this check was written to avoid. The read now
  strips a trailing newline only.
  
  The refusal condition is also stated honestly for the first time. It rests on two
  grounds, and only one of them involves a session id: the pointer's recorded id
  matches ours and the transcript it named could not be reached, or the id could
  not be read at all and the file nonetheless sits at this project's own pointer
  path owned by this user. An earlier revision set a single `corroborated` flag
  from `Boolean(currentSessionId)` on branches where the id was never read, which
  asserted a match that had not been established and left three shipped documents
  describing a rule the code did not implement. Those documents now describe both
  grounds.
- b0e8078: A stale transcript pointer no longer refuses a commit.
  
  Two reviewers reached opposite conclusions on this. The first read a stale
  pointer as wiring that resolved and could not be reached — a defect. The second
  showed that refusing it blocks a correctly wired host: a second agent session in
  the same project directory sees the first session's pointer until its own Stop
  hook fires, which by construction is only after its first turn completes, so its
  very first commit is refused — and the remedy the message named (`--transcript`)
  is a flag `vinaya check` does not accept, leaving no action that clears it.
  
  The second reading wins. A pointer whose recorded session id disagrees with the
  current one is provably NOT this session's, which is the can't-claim-it case,
  not a broken-wiring case. `corroborated` now means one thing everywhere — "can
  we show this pointer is ours" — which is also what the three shipped docs had
  said all along while the code did something else.
  
  Two related corrections ride along. A verdict degraded to
  `no-transcript-resolved` now carries a detail consistent with that reason, where
  before it kept a detail asserting a transcript HAD been resolved and was
  unreadable — a contradictory pair that reached `vinaya doctor` and `pr report`'s
  token cell. And `isTokenCollectionWiringBroken` returns a plain boolean again:
  as a type predicate it was unsound, since `false` also covers the sanctioned
  incapable case, so the negative branch narrowed to `capable: true` and a
  `.summary` dereference compiled clean while throwing at runtime.
- Updated dependencies [21ccea4]
- Updated dependencies [4c0f755]
  - @attalabs/aeg-forge-state@0.21.0
  - @attalabs/aeg-types@0.21.0

## 0.20.1

### Patch Changes

- cee19e1: Adds a `files` allowlist to all four packages that previously had none, so `npm pack`/`npm publish`
  ships only each package's real entry-point surface instead of the whole working directory (`#180`).
  `aeg-core` no longer ships its `bin/` CLI scripts, `*.test.ts` files, or `src/fixtures/**`; the other
  three drop their `*.test.ts` files. Test fixtures for all four packages — including `aeg-forge-state`'s
  six verbatim internal Issue-body fixtures and `aeg-core`'s `docs-coherence` synthetic doctrine trees —
  move from `src/fixtures/` to a `tests/fixtures/` directory beside the suites that read them, so the
  disclosure is closed by relocation regardless of the allowlist. No behavior change for any real import:
  each package's documented entry point and named sub-exports were proven to resolve from a fresh
  `npm install` of the packed tarball outside this workspace.
- Updated dependencies [cee19e1]
  - @attalabs/aeg-forge-state@0.20.1
  - @attalabs/aeg-types@0.20.1

## 0.20.0

### Minor Changes

- 47dc992: Registers `main-branch-refusal` as a real, adopter-runnable ring-0 core check (`coreCheckRegistry()`):
  refuses a commit or push whose current branch IS the repo's default branch, mechanizing the
  worktree-plus-PR rule for every adopter through `vinaya init`'s generated `check --all --local` hooks —
  today that rule reached only this monorepo's own hand-written husky script, with a real direct push
  detected post-merge (`vinaya audit --only=direct-push`).
  
  The discriminator is the SYMBOLIC current branch, not any derived name: `git symbolic-ref --short HEAD`
  equaling the local `origin/HEAD`-derived default branch refuses; a detached HEAD (every CI checkout)
  always passes, never refused. The default branch is never hardcoded as `main` — when it cannot be
  resolved locally, the check fails open with a `warning` finding instead of risking a false block. A
  genuine refusal is a real failure (`error`, exit `1`): this is an action refusal, not a doctrine-parity
  report, so report-only would defeat the check's one job.

### Patch Changes

- @attalabs/aeg-forge-state@0.20.0
  - @attalabs/aeg-types@0.20.0

## 0.19.3

### Patch Changes

- 705dbfe: Adds a `commit-msg` hook to the managed-artifact set, enforcing this repo's `Type(scope):
  Description` commit convention. `vinaya init`/`vinaya upgrade` now install a third managed hook
  beside `pre-commit`/`pre-push`; `vinaya eject` removes it the same way. The commit-type vocabulary
  is exported from `@attalabs/aeg-core` as `COMMIT_TYPE_STYLE`/`COMMIT_TYPES` — the same list
  `checkForgeTitle` already enforced on PR/Issue titles.
- a5f6097: Adds an `Audience` column (`product` | `repo-own`) to every row of `aeg-root/enforcement.md`'s three
  ring tables, marking whether a row's implementation ships as a real, adopter-runnable check
  (`coreCheckRegistry()`) or is specific to how this repository enforces itself on top of the product.
  `registry-parse.ts` reads the column by header name, defaulting an absent column to `repo-own` — an
  un-upgraded adopter copy of the doctrine is unaffected.
  
  Adds G6, a new blocking registry check: every row marked `product` must actually resolve to a
  `coreCheckRegistry()` entry. It closes the gap the tranche's own gap audit named — a doctrine row can
  claim shipped enforcement that no adopter's `vinaya check` ever runs, and nothing previously compared
  the two. G6 runs only from `apps/cli`'s `check-registry-gates.ts`, since `coreCheckRegistry()` lives
  there and `aeg-core` cannot import it without closing a dependency cycle; the standalone
  `packages/aeg-core/bin/verify-registry.ts` prints an explanatory note and skips it.
  
  Also re-grades G1 (implementation-exists) from report-only to blocking: its report-only window had
  already cleared the orphan backlog it existed to surface, and a permanent `info` finding on every run
  had become indistinguishable from silence — precisely how the gap G6 closes stayed invisible for as
  long as it did. G2 (no-orphan-hook/CLI) is unchanged, still report-only.
- @attalabs/aeg-forge-state@0.19.3
  - @attalabs/aeg-types@0.19.3

## 0.19.2

### Patch Changes

- @attalabs/aeg-forge-state@0.19.2
  - @attalabs/aeg-types@0.19.2

## 0.19.1

### Patch Changes

- 4347c56: A tranche adopted into a real Milestone (`vinaya milestone adopt`) could permanently read as `complete`
  system-wide, even with real open Issues, because the retired one-tranche Milestone `adopt` closes
  (never deletes, by design — its provenance survives) still title-matches the legacy 1:1 exception every
  tranche reader checks first. `matchesLegacyMilestone`'s "kept forever, no exception" rule was written
  for a Milestone that never changes underneath a slug — true for every pre-migration Milestone, false
  the moment `adopt` exists.
  
  Found live: `vinaya-agentic-interface-v1`'s legacy Milestone (`#7`) sat closed with zero native issues
  after adoption; its real Issues (two open) live under the new consolidated "Flows become files"
  Milestone via the `vinaya/tranche:vinaya-agentic-interface-v1` label. `findMilestoneForSlug`,
  `listActiveTrancheSlugs`, `listArchivedTrancheSlugs`, and `indexTrancheMilestonesAsync` all reported it
  `complete` — which made `verify-coherence.topology-move.test.ts`'s live-forge assertion (some tranche
  resolves active) fail repo-wide, since every adopted tranche in the repo hit the same shadow. That test
  gates `verify-task`, which `open-pr.ts` runs unconditionally — so no task-branch PR could open in this
  repo until this fixed.
  
  `resolveLegacyFacts` now checks the slug's `vinaya/tranche:<slug>`-labeled Issues before trusting a
  closed legacy Milestone's `state`: a non-empty label population is this tranche's real, current
  identity and wins over the (possibly stale) Milestone read. An empty label population — a genuinely
  historical, pre-label-model tranche, or a legacy Milestone nobody has adopted away from — still resolves
  from the Milestone's own `state`, exactly as before. All four readers now fetch that slug's Issues
  regardless of legacy status, which the async index runs concurrently with everything else it already
  fetches.
- 5ebf782: Registers `reader-resolvable-prose` and `retired-vocabulary` as real, adopter-runnable core checks
  (`coreCheckRegistry()`), so an installed `vinaya check --all` actually runs them instead of only this
  monorepo's own internal dev loop.
  
  `reader-resolvable-prose`'s three repo-specific inputs — doctrine root, reader-facing page globs, and
  the legacy-slug archive location — now come from `vinaya.config.json`'s new `proseGates` key, read fresh
  on every check run. Unset entirely, both checks keep this repo's own prior hardcoded shape
  (`doctrineRoot: "aeg-root"`, a dormant reader-facing sweep), so an existing install sees no change until
  it opts in. `retired-vocabulary` gives `retired-vocabulary.test.ts`'s genuinely-retired vocabulary scan
  (never its forge-number/tranche-slug citation half, which stays `reader-resolvable-prose`'s job) a
  CheckSpec adapter for the first time, scoped to `<doctrineRoot>/**`.
  
  Both ship report-only (a `warning` finding, exit code always `0`), same rollout precedent as the G1/G2
  gates — registering them cannot newly fail any existing install's CI.
  
  Also fixes a latent bug the registration surfaced: `check-reader-resolvable-prose.ts`'s
  `REPO_ROOT`/`process.chdir()` computed its OWN installed-package location rather than the caller's repo
  root, and both new checks' human-readable summary line printed to stderr — the CheckError JSON channel —
  which the runner reads any non-JSON line on as `status: 'error'` regardless of exit code. Neither bug was
  reachable before this task, since neither check had ever run outside this monorepo's own dev loop or
  through the check runner at all.
- Updated dependencies [4347c56]
  - @attalabs/aeg-forge-state@0.19.1
  - @attalabs/aeg-types@0.19.1

## 0.19.0

### Minor Changes

- a438d2b: A Milestone now means a product goal, not a tranche. Previously a GitHub Milestone and a tranche were
  1:1, matched by title — a Milestone could hold exactly one tranche and nothing wider. It now holds
  many:
  
  - `vinaya milestone create` — makes a real product-goal Milestone, with an optional `Release:` target
    version, gated by `checkMilestoneShape` before any forge write.
  - A tranche's lifecycle (`planned`/`active`/`complete`) derives from its `vinaya/tranche:<slug>` label
    and Issue set, not from a Milestone title — `fetchMilestone` no longer requires a Milestone to exist
    at all for a tranche to resolve. A Milestone titled exactly a known tranche slug still resolves the
    old way, so nothing existing needs migrating.
  - The **Architect** role — a goal in, an ordered list of tranche intents out. Invoked manually; it
    never cuts task Issues itself, that stays the Planner's job one altitude down.
  - `vinaya milestone adopt` — moves an existing tranche's Issues into a real Milestone and closes (never
    deletes) the retired one-tranche Milestone, refusing atomically before any write on an unknown slug,
    an empty tranche, a closed/missing target, or a slug already adopted elsewhere.
  
  No `managed.*` config key was added for this — creating a milestone is one `vinaya milestone create`
  call per milestone, run by hand, not a desired-state declaration for an installer to converge on.

### Patch Changes

- efb570a: `vinaya pr create`, `vinaya pr edit`, and `open-pr.ts` now run the `body-bare-digits` check before
  any forge write, instead of only in CI after the pull request already exists.
  
  `body-bare-digits` is one of four checks marked `requiresOpenPr` — the other three (`closes-n`,
  `test-plan`, `evidence-fresh`) genuinely need a PR number or PR comments and cannot run earlier. This
  one is a pure function of body text with no such excuse: a bare digit outside a fenced code block or
  an `AEG:*` anchor was always knowable before the write, and the gate ran anyway only in
  `pull_request_target` CI, after the body had already reached GitHub. Two of the four workflows re-fire
  on a body edit, so a check that could have refused locally instead cost a live CI run and a second
  edit to fix.
  
  `gatePlanForBranch` in `open-pr.ts` now includes `body-bare-digits` in the base plan for every branch,
  not only task branches — the check itself, not a branch condition, exempts
  `changeset-release/main`. `vinaya pr create` and `vinaya pr edit` refuse with the same
  `CheckError` shape either command already uses for `validateForgeWrite` failures, before the `gh`
  call.
  
  No behavior change to what counts as a violation — `checkBareDigits` itself is unchanged. The
  `tests/fixtures/forge/pr-valid.md` fixture, which predates this gate, carried a bare version number
  and a bare `Closes #385`; both are now backticked/anchored so the fixture still represents a body that
  should pass.
- Updated dependencies [a438d2b]
  - @attalabs/aeg-forge-state@0.19.0
  - @attalabs/aeg-types@0.19.0

## 0.18.0

### Minor Changes

- f93674c: Every governance gate under `packages/aeg-core/bin/` now declares who it is for, and a test fails the build when one does not. Membership of the adopter-facing set was previously defined by ABSENCE from `coreCheckRegistry()`, so a deliberate exclusion and a forgotten port left exactly the same trace — nothing could tell "adopters should not run this" from "we forgot to ship it". `GATE_AUDIENCE` makes the second column something you have to say, with a reason: `{ shippedAs: '<core check name>' }` for gates adopters run, `{ internal: '<why not>' }` for the ones this repo keeps to itself, and a separate `NON_GATE_BINS` list for the forge writers and reporters in that directory that are not gates at all. Adding a file to `bin/` and nothing else is now a failing test that names it. Deliberately not a field on `CheckSpec`: adopter-defined checks in `vinaya.config.json` produce that same shape, so an audience field there would push an internal-governance question into adopter config, where it cannot be answered.
  
  Covers both sides of the boundary. `GATE_AUDIENCE` accounts for every bin under `packages/aeg-core/bin/`, and `SHIPPED_BIN_AUDIENCE` for every executable under `apps/cli/src/checks/bin/` — both asserted in the CLI's own suite, where `coreCheckRegistry()` is in scope, so a `shippedAs` naming a check that does not exist fails a test rather than being trusted. The shipped side is where the motivating case actually lives: `reader-resolvable-prose` has no bin in aeg-core at all, so an aeg-core-only enumeration would never have seen the exclusion it was built to make visible. Both enumerations walk recursively and accept `.ts`/`.mts`/`.cts`, because a gate whose enumeration is narrower than the directory it guards has a door in the back.
  
  Both enumerations refuse a symlink rather than skipping it. `readdirSync(dir, { withFileTypes: true })` reports a symlink-to-directory as `isDirectory() === false`, so an unfollowed symlink fell through to the extension filters and was dropped in silence — a symlinked directory holding an undeclared gate passed both suites green. The `shippedAs` validation iterates the two maps separately rather than spreading them into one, because the namespaces overlap and a spread let the second map shadow the first, dropping the shadowed entry's declaration from validation entirely.

### Patch Changes

- c844163: `verify-dispatch`'s baseline no longer reports a healthy `verify-coherence` as `UNAVAILABLE (tool failed to run)`. It captured the child's stdout and stderr and concatenated them before `JSON.parse`, on the stated premise that neither tool writes to stderr on its clean `--json` path. That premise was false: `verify-coherence` probes `aeg-root/tranches` and `aeg-root/tranches/completed` off the base ref, the forge-native cutover deleted those directories — `no-disk-state.ts` now actively forbids re-adding one — so `git` prints a `fatal:` line per probe while the tool itself exits 0 with correct results. One such line made the parse throw, and every dispatch check reported the oracle as dead. The two streams are now kept apart and each caller reads the one its own parse needs: `verify-coherence` is parsed, so it reads stdout alone; `verify-docs` is line-counted, so it still scans both and a finding printed to stderr still counts. Separately, the two probes in `verify-coherence` that legitimately miss on every healthy run now silence the child's stderr rather than letting an expected absence print a `fatal:` line the caller has to parse around. The load-bearing consequence is not the cosmetic line: concatenation made a genuinely crashed run and a chatty healthy one indistinguishable, so the field could no longer surface the thing it exists to surface — an unparseable stdout is still reported `UNAVAILABLE`, and there is now a test pinning that.
  
  Two further changes to the same baseline, both adopter-visible. The reported count is now validated as a **shape**, not merely as parseable JSON — a scalar, an array, or an object without a numeric non-negative `summary.failed` reads as `UNAVAILABLE` rather than throwing a `TypeError` on property access, which splitting the streams had newly made reachable. And a sweep that ran but could not reach the forge (`forgeUnavailable`) is now `UNAVAILABLE` too: its checks evaluate against only the tranches it could see, so `failed` is a smaller number arrived at honestly, and comparing it as a finding count under-reports. Before the streams were split an outage happened to fail closed, because it also wrote to stderr and the concatenated parse threw; this restores that on purpose.
  
  **This can make `verify-dispatch --check-baseline` refuse where it previously compared** — a forge outage, or a malformed report, now blocks the comparison instead of scoring it. That is the intended direction (an unavailable tool carries no honest count), but it is a behaviour change for anyone running that mode. The gate-mode baseline is informational and unaffected in verdict, only in what it prints.
  
  The `UNAVAILABLE` line no longer claims "tool failed to run", because that is now sometimes false — a forge-degraded run *did* run. It reads "no usable finding count", and the accompanying diagnostic says which of the two happened. Diagnostics from the child are surfaced rather than dropped, and one over `300` characters is marked as truncated instead of ending mid-token.
- Updated dependencies [70e887e]
  - @attalabs/aeg-forge-state@0.18.0
  - @attalabs/aeg-types@0.18.0

## 0.17.1

### Patch Changes

- @attalabs/aeg-forge-state@0.17.1
  - @attalabs/aeg-types@0.17.1

## 0.17.0

### Minor Changes

- 6dfe0f5: `vinaya issue create`/`vinaya issue edit` now run the three Issue-only content checks `packages/aeg-core/bin/open-issue.ts` has always gated task Issues on — `checkBlastRadiusScope`, `checkNoBriefContent`, `checkRationaleNamesDocs` — which had never been wired into the published CLI's own reimplementation of that validation path. Every adopter using `@attalabs/vinaya` (not only this repo) previously had only the 14 section-presence checks enforced on `issue create`/`edit`; a task Issue could carry a fully-formed but factually wrong rationale (an under-declared blast radius, brief-shaped content copied into the Issue, a rationale naming no doc it actually read) and pass. These three now run, unconditionally, immediately after the existing rationale-presence gate, for any Issue carrying a `vinaya/tranche:*` label.
  
  **Also retires the legacy `.aeg/packages` static collision-domain file, in both packages, with zero backward compatibility.** `checkBlastRadiusScope`'s domain list (`readSharedPackages`, in `open-issue.ts` AND the new `apps/cli` equivalent this same change adds) is now exactly: live-derived `packages/*` workspace members, the built-in cross-cutting default set, and `vinaya.config.json`'s `blastRadius.extraDomains`. A present `.aeg/packages` file is no longer read by the check at all — `vinaya doctor` still diagnoses it as a migration checklist, but it contributes nothing live. Principal decision: no adopter outside our own control depends on it, and it's being removed from the one real external consumer (attalabs) in this same wave.

### Patch Changes

- @attalabs/aeg-forge-state@0.17.0
  - @attalabs/aeg-types@0.17.0

## 0.16.0

### Minor Changes

- acb6021: `checkBlastRadiusScope` no longer requires a hand-authored `.aeg/packages` file. Its collision-domain list now derives live from `package.json`'s `packages/*` workspace members, plus a built-in cross-cutting default set (whichever lockfile exists, `turbo.json`/`biome.json`/`tsconfig.json`, `.github/workflows`, `.husky`). A legacy `.aeg/packages` file, if present, still adds its entries on top — additive, never replaced. `vinaya.config.json` gains an optional `blastRadius.extraDomains: string[]` field for anything beyond the automatic sources (a `migrations/` folder, a codegen output dir). `vinaya doctor` reports a present `.aeg/packages` as deprecated, naming exactly which entries (if any) still need migrating.

### Patch Changes

- @attalabs/aeg-forge-state@0.16.0
  - @attalabs/aeg-types@0.16.0

## 0.15.0

### Patch Changes

- @attalabs/aeg-forge-state@0.15.0
  - @attalabs/aeg-types@0.15.0

## 0.14.0

### Patch Changes

- da64fd0: `vinaya doctor` now flags `.vinaya/doc-owners` bindings whose code glob matches no tracked file in the repo, or whose doc pointer doesn't exist on disk — both silent gaps the diff-scoped C5 gate structurally cannot see on its own, since a glob matching nothing trivially satisfies "did the docs change" for every diff. Report-only, like every other `doctor` diagnostic — it never mutates `.vinaya/doc-owners` and is not a `vinaya check` gate.
- Updated dependencies [da64fd0]
  - @attalabs/aeg-forge-state@0.14.0
  - @attalabs/aeg-types@0.14.0

## 0.13.1

### Patch Changes

- 7d23b7f: `vinaya doctor` now reports when no workflow under `.github/workflows/` appears to invoke the repo's own `package.json` test script. Vinaya requires a Test Plan on every pull request and enforces it as a blocking gate, but had no visibility into whether anything actually runs the tests that plan claims to cover. The diagnostic is a narrow heuristic — a short literal list of test-invocation substrings, scanned across every workflow file, not only the four vinaya-generated ones — and reports at `warn`, never `error`; it accepts false negatives rather than trying to be exhaustive.
- Updated dependencies [7d23b7f]
  - @attalabs/aeg-forge-state@0.13.1
  - @attalabs/aeg-types@0.13.1

## 0.13.0

### Minor Changes

- 3a9ef15: **Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `headSha` field — the PR's current head commit (`gh pr view --json headRefOid`). A caller that does not supply it no longer compiles; an optional field that silently skipped the binding check on absence would fail open, the exact defect this closes (#73). `VerdictExtraction` gains `headSha: string | null`, parsed from a same-comment `Judged head: <sha>` line with the same anchor discipline as the `VERDICT:` marker itself (abbreviated or full sha, blockquote/list/heading/code-span excluded). `checkReviewGate` now requires both the code-review and security-review verdicts to be clean AND bound to the current head — a verdict that predates a later push, or carries no `Judged head:` line at all, fails the gate, naming both the verdict's sha and the current head. Every verdict already posted on an open PR carries no such binding and is fail-closed by this change: re-cast the verdict at the PR's current head, or a principal can apply the actor-verified `vinaya/waiver:review` label as a one-PR transition escape. `aeg-root/roles/reviewer.md` and `roles/security.md`'s `VERDICT:` output block both gain the `Judged head: <sha>` line.

### Patch Changes

- 8b2f8b6: `vinaya check --json` previously truncated its payload at the reading pipe's buffer, because the process exited on top of a pending asynchronous stdout write — a file redirect never exposed it, since a file's stdout write is synchronous. Any consumer piping the output, `vinaya pr report` among them, received unparseable JSON above that buffer. The payload now drains before the process exits, with exit codes unchanged.
- Updated dependencies [8b2f8b6]
- Updated dependencies [3a9ef15]
  - @attalabs/aeg-forge-state@0.13.0
  - @attalabs/aeg-types@0.13.0

## 0.12.0

### Patch Changes

- 5f3ed65: `Doc-neutral:` now clears a fired C5 doc-coverage binding in the merge-blocking check, not only in `verify-docs`. `evaluateC5` verifies the declaration by reading the matched file's diff, and both check bins called it without that argument — so the gate's own failure message instructed the user to declare `Doc-neutral:` while that declaration could never succeed in CI. Both bins now pass a shared per-file diff closure, against the ref that actually produced the changed-file list rather than the requested base (both re-resolve to `main` when `origin/main` yields nothing).
- 4018b71: New `vinaya pr report --write <body-file>` emits the `AEG:EVIDENCE` block — a PR body's head sha, a width-invariant `git diff --numstat`, and the result of `vinaya check --all --diff-only` — from commands, never typed by hand. The new `evidence-fresh` core check refuses a PR body whose block doesn't match the head it's attached to: it recomputes and exact-compares the diff stat (closing fabrication for that fact) and checks the attested gate run for staleness only, against the PR's real head resolved via `gh` (never `HEAD`, which is the merge commit in CI). `ANCHOR_FIELDS` gains `EVIDENCE`; `aeg-root/templates/pr-report-template.md` and `aeg-root/roles/developer.md` both route their PR-body "evidence" section through the new anchor instead of free text.
- Updated dependencies [5f3ed65]
- Updated dependencies [4018b71]
  - @attalabs/aeg-forge-state@0.12.0
  - @attalabs/aeg-types@0.12.0

## 0.11.0

### Patch Changes

- @attalabs/aeg-forge-state@0.11.0
  - @attalabs/aeg-types@0.11.0

## 0.10.0

### Minor Changes

- 264a8ae: The repo-wide coherence sweep stops re-fetching forge data it already holds. `verify-coherence.ts`'s `loadTrancheFiles` derived each tranche independently, so a repo with N Milestones paid N re-pulls of the entire Milestone list plus N serial `gh issue list` calls, and L4/L5 then re-issued those same N Issue queries a second time for the `milestone` field a `Tranche` drops. The sweep now enumerates every tranche first, indexes Milestones once (`indexTrancheMilestonesAsync`), fetches each tranche's labeled Issues exactly once at a bounded concurrency of 4, and derives both the task list and L4's Milestone-attachment facts from that single response. Measured against `atta-labs/vinaya` (6 Milestones): 21 `gh` calls and 26.4 s become 7 and 9.5 s, with byte-identical report JSON — the derivation, the checks, and the verdict are unchanged, only the round trips are gone. New `@attalabs/aeg-forge-state` exports for callers that hold forge data already: `indexTrancheMilestonesAsync`, `fetchTrancheIssuesAsync`, `trancheFromIssues`, `tasksFromIssues`, `issueMilestonesFromIssues`, and the `TrancheMilestoneIndex`/`GhIssue` types. Every existing export keeps its signature and behaviour. `indexTrancheMilestonesAsync` is paginated via the new `ghApiGetAllPagesAsync`: Milestones are append-only, so the single `per_page=100` page the older readers use is a countdown rather than a bound, and silent truncation in the index a repo-wide sweep enumerates from would drop tranches from every check with no error. The sweep also keys its Milestone fill-in on which tranches were actually produced rather than which were enumerated, so a PR that deletes or archives a topology file can no longer narrow the sweep — the deletion case fell through to a forge derivation as before, and an archival move (`tranches/x.md` to `tranches/completed/x.md`) keeps the PR head's own content and its `archived` flag. Forge unavailability is reported rather than thrown or absorbed, on every path: a lost Milestone index refuses the run when nothing local can be enumerated, and withholds L4/L5 — whose only active-tranche authority it is — when topology files keep the sweep non-empty, rather than letting an empty authority read as "no drift"; a per-tranche read that fails with no file to stand in names the omitted slugs. `ghApiGetAllPagesAsync` sets `per_page` itself rather than trusting the caller's path, because the page size IS its stop condition, and refuses to walk past a page ceiling instead of looping without bound. The sweep's two git readers now spawn `git` with an argv array rather than interpolating a ref and a path into a shell string: one of those paths is assembled from a Milestone title, so through a shell a title carrying a command substitution executed, while as one argv element it is only a filename git fails to resolve — which both readers already treat as absent.

### Patch Changes

- 6e3cf0f: The four generated workflows now invoke `npx --yes @attalabs/vinaya@<exact-installed-version>`, the same exact-version pin the generated git hooks already carried and from the same source (`ownVersion()`). Previously they emitted a bare `npx --yes @attalabs/vinaya`, which reads as "always latest" and is not: where `vinaya-checks.yml` carries an install step — which it does only when the adopter declares `ci.setup` — a repo carrying the CLI as a devDependency resolved `node_modules/.bin/vinaya` instead of the registry, measured as `0.8.2` inside such an adopter repo against `0.9.0` in `/tmp`. There, CI's version was an accident of a dependency no workflow referenced, and changing that dependency moved CI to registry latest with no commit and no diff. An adopter declaring no `ci.setup` gets no install step at all, so for them a bare spec resolved registry latest in all four workflows. The generated workflows are managed artifacts, so `vinaya upgrade` rewrites an existing install's unpinned workflows to the pinned shape and re-pins them on each version bump; `vinaya doctor` reports a stale pin as drift. The git hooks are unchanged.
- 32a01e2: The shipped token-report doctrine no longer names a host tool's script as the requirement. `aeg-root/tranche-model.md` §12 now states the obligation as three layers — every role reports its own turn's usage (portable), collected by whatever means its host offers (host-specific), into the `Tokens: …` grammar in the artifact its turn produced (portable) — so an adopter on any harness implements only the middle layer and inherits the rest unchanged. The role docs (`developer.md`, `archivist.md`, `planner.md`, `reviewer.md`, `security.md`, `tranche-archivist.md`), `state-machine.md` and `enforcement.md`'s registry row now cite `bin/report-tokens.ts` as *the Claude Code way* to satisfy collection rather than as the rule. The taxonomy that split roles by Anthropic product name ("terminal roles run in Claude Code" vs "claude.ai roles run in chat") is replaced by the capability it was actually describing: **self-metering** (the host exposes the session's own usage to the agent) vs **operator-metered** (it does not), both defined in `glossary.md`. Per-cell `—` optionality is now conditioned on that host capability rather than on the role, and `state-machine.md`'s stale, already-retracted `(terminal: /cost)` claim is gone.
  
  The obligation itself is unchanged and is not weakened: reporting stays mandatory, `—` stays sanctioned only where a host exposes no usage to the agent at all, and the no-estimate rules carry forward in substance, restated as one capability-conditioned rule rather than two role-specific ones.
  
  `@attalabs/aeg-core` gains `src/claude-code-transcript.ts`, which now homes `summarizeTranscript` — it parses one vendor's transcript JSONL and its `usage` field names, so it was never portable despite living beside the portable renderers. `TranscriptSummary` is now documented as the adapter seam: an adapter's whole contract is to produce that shape, and everything downstream of it (`formatTokensLine`, `parse-token-report.ts`'s grammar) is shared by every host. No exported name, type or behaviour changes — `summarizeTranscript` is still exported from the package root. `bin/report-tokens.ts` gains a declared `--transcript <path>` flag (previously reachable only by accident, as a bare positional) and reframes its missing-pointer error: naming your own transcript is a supported primary route, and a repo that installs no `track-transcript.sh` Stop hook — this one included — is not misconfigured for lacking a pointer file.
- Updated dependencies [264a8ae]
- Updated dependencies [6e3cf0f]
- Updated dependencies [32a01e2]
  - @attalabs/aeg-forge-state@0.10.0
  - @attalabs/aeg-types@0.10.0

## 0.9.0

### Patch Changes

- 7d939d8: `vinaya studio` now launches for real in a published install. `bundle-studio.ts` fetches attalabs' CI-built standalone Studio bundle from its public release artifact (`atta-labs/attalabs`'s `vinaya-studio-artifact.yml` workflow, no token required) and assembles it into `studio-standalone/` at `prepack` time, instead of requiring a Studio source tree this repository never had. The default ports move from `3006`/`3106` (the retired `apps/vinaya/web`'s ports) to `3008`/`3108` (matching `apps/vinaya-studio/web`'s own docs). `packages/sources/src/commands.ts`'s `studio` row and `verify-published-lifecycle.ts`'s `studio` exercise both now describe and assert a real launch instead of the prior honest refusal.
- Updated dependencies [7d939d8]
  - @attalabs/aeg-forge-state@0.9.0
  - @attalabs/aeg-types@0.9.0

## 0.8.2

### Patch Changes

- 9d730e1: Fix the `doc-coverage` check so an applied `vinaya/waiver:docs` label actually takes effect. It previously read `PR_LABELS`/`WAIVER_LABEL_ACTOR` from the environment, expecting the CI workflow to inject them — but no generated `vinaya-checks.yml`, old or current, ever set either var, so the waiver path was silently unreachable in every adopter's CI (caught live on atta-labs/attalabs#948). The check now resolves the label and its labeling actor live via `gh`, from `PR_NUMBER`, the same way `review-gate` already does — no workflow template change needed, and every already-generated `vinaya-checks.yml` is fixed in place.
- Updated dependencies [9d730e1]
  - @attalabs/aeg-forge-state@0.8.2
  - @attalabs/aeg-types@0.8.2

## 0.8.1

### Patch Changes

- 30dc300: Recognize a hand-closed dependency Issue as valid when it was closed directly by a recognized Principal identity (verified via GitHub's own `ClosedEvent` actor, not claimed in prose), instead of only accepting a merged closing PR. `dispatch-gate` and `coherence` check A1 both gain this second, narrower recognition path — the default merged-PR path is unchanged.
- Updated dependencies [30dc300]
  - @attalabs/aeg-forge-state@0.8.1
  - @attalabs/aeg-types@0.8.1

## 0.8.0

### Patch Changes

- @atta/aeg-forge-state@0.8.0
  - @atta/aeg-types@0.8.0

## 0.7.1

### Patch Changes

- 334c9d4: The four engine packages are now publicly published: `private: true` dropped, `publishConfig.access: "public"` added, and `.changeset/config.json`'s `privatePackages.tag` flipped to `true`. First public versions of `@atta/aeg-core`, `@atta/aeg-types`, `@atta/aeg-forge-state` and `@atta/vinaya-sources` ship on the next `changeset publish`, alongside `@attalabs/vinaya` as the same fixed-group version.
- Updated dependencies [334c9d4]
  - @atta/aeg-types@0.7.1
  - @atta/aeg-forge-state@0.7.1

## 0.7.0

### Patch Changes

- @atta/aeg-forge-state@0.7.0
  - @atta/aeg-types@0.7.0

## 0.6.0

### Patch Changes

- 6a3f006: Key the generated workflows' concurrency group on the head commit as well as the pull request, so a rerun of an earlier commit's run cannot cancel the current one.
  
  Keyed on the pull request alone, every run for that pull request shared a single group — including reruns of earlier commits, which the verdict retrigger performs. Measured: re-running the previous commit's run cancelled the current commit's run one second after it started, so pushing to a pull request appeared to produce a cancelled review gate. Runs for the same commit still collapse, which is the duplicate the group exists to remove.
- dbb8acd: Fix the generated review gate so a pull request holding clean verdicts reports green without human intervention.
  
  Two defects, both in workflows `vinaya init` writes into every adopter's repository:
  
  - **Duplicate runs.** `vinaya pr create` opens the pull request and applies its tranche label immediately after, so `opened` and `labeled` arrive together and GitHub starts two runs of the same workflow. Both report under one check name and the merge box counts both, so one could go green while its twin held a stale red. The two `pull_request`-triggered workflows now carry a concurrency group keyed per pull request.
  
  - **The verdict retrigger selected the wrong run.** It re-ran every completed run, which put several into one concurrency group at once and had `cancel-in-progress` kill all but the last — cancelled runs report red. Selecting the newest was also wrong: `--status completed` excludes a run that is re-running but includes cancelled ones, so a verdict arriving mid-flight could rerun a stale cancelled sibling and cancel the live evaluation. Selection is now by head SHA, excluding cancelled runs — the run for the current head is the only one whose conclusion gates the merge.
  
  Unchanged: the gate still fails when no verdict exists. "Nobody has reviewed this" must block a merge.
- @atta/aeg-forge-state@0.6.0
  - @atta/aeg-types@0.6.0

## 0.5.0

### Patch Changes

- d4a12db: Make SCOPE layout-agnostic for the retired-vocabulary sweep.
  
  `@atta/aeg-core` is private and never published directly, but it is inlined
  into `@attalabs/vinaya`'s bundle, so this change ships as part of the CLI's
  next release under the fixed group.
- @atta/aeg-forge-state@0.5.0
  - @atta/aeg-types@0.5.0
