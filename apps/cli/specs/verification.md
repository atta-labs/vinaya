# Dependency-based verification for local push and CI

Status: draft

## Purpose and guarantees

Local publication and continuous integration use one dependency model and one read-only test-selection engine. Each consumer runs the verification required by its comparison range and explicit policy. Necessary work is retained even when expensive; unrelated work is omitted only when the model and independent verification justify that omission. Unknown dependencies produce explained broader coverage, never a successful empty answer.

The architecture separates dependency analysis, policy, native scheduling, execution, and publication proof. It neither requires reviewers to await remote CI nor changes reviewer dispatch order. Local publication success does not stand for every platform-specific CI obligation. Full default-branch verification remains a backstop.

## Layers and ownership

1. **Canonical inventory and inputs.** Discover executable native test/configuration identities, owners, roots and non-executable fixture exclusions. Resolve compiler imports/re-exports, declared readers, scanners, spawned programs, configuration domains, preloads, runner/dependency inputs and references to authoritative input providers into one input model. Repository paths and Vinaya-specific knowledge belong in repository adapters/declarations, not the generic engine.
2. **Read-only selection.** Compare immutable revisions through a reusable engine. The engine returns test identities, reasons, explicit fallback scopes and reproducibility context. It does not select its own passing anchor, execute tests, contact a forge, mutate records or decide merge authority.
3. **Native groups.** Group explicit identities by native runner, working directory, configuration, preload and environment. CI adds shard/job placement. Local execution uses the same grouping/report validation without inheriting CI-only exclusions or topology.
4. **Push integration.** Validate prior proof, choose a comparison base, retain unresolved failed tests, execute the resulting local obligations and persist truthful head-bound results/Evidence.
5. **CI integration.** Choose the PR/default-branch comparison and tested tree, select dependency-required tests, add build/typecheck/lint/configuration/sandbox/governance duties and their prerequisites, execute jobs and aggregate required completion.

The CI task planner is not another test selector. Its additional task/prerequisite analysis consumes the same canonical input facts rather than copying file/key dependency lists.

## Read-only selection interface

Conceptual API, independent of repository layout or publication mechanism:

```ts
selectTests({ repo, base, head, inventory, policy }): SelectionPlan
```

`repo` provides read-only committed-tree/blob access. `base` and `head` resolve to exact immutable commit/tree identities before planning. Fetching missing objects is caller preparation, never an implicit network side effect of selection. Uncommitted source is not silently substituted for a requested revision. Missing objects or unreadable blobs are explicit errors/fallbacks, never absence fabricated from a failed read.

`inventory` supplies validated native identities and the versioned input model applicable to both revisions. The implementation may use a validated base/head view of the canonical store; it must not mistake the candidate inventory's version for proof of the older tree's dependency completeness. The schema is a producer/consumer contract, not a duplicate inventory per consumer.

`policy` supplies generic coverage obligations and supported execution configurations. Repository adapters translate Vinaya configuration and mandatory-test rules into this input. Invocation-specific state such as passing-record locations, task identifiers, issue numbers and CI job names is outside this interface.

The result contains:

- Sorted stable selected test/configuration identities, with dependency-required and policy-added identities distinguishable.
- Machine-readable reasons for every selected identity, including source/input paths and dependency or policy attribution.
- Every broader fallback's reason, triggering input and expanded scope; a complete native suite must not be presented as precise per-file impact.
- The resolved comparison identities, tested tree where applicable, engine/input-model/policy identities, and native configuration context needed to reproduce the plan.
- Diagnostics/unsupported shapes sufficient to distinguish a proven empty dependency set from unknown coverage.

Identical immutable inputs produce the same ordered semantic plan. Wall-clock timestamps, checkout locations, random IDs and performance measurements are diagnostic metadata and excluded from semantic plan identity. Stable identities use repository-relative paths plus required configuration identity, not one machine's absolute paths.

## Impact semantics

- Follow required dependency closure, preserving justified named-export precision. Do not use an arbitrary traversal limit to label indirect dependencies unnecessary.
- Examine relevant base and head relationships for removed imports, deletions, renames, changed exports and added/deleted tests. A head-only graph is insufficient.
- A package content file is not automatically package-resolution metadata. Model package manifests/exports/main, compiler settings, lockfiles, runner configuration and preloads by their actual effect; opaque shapes broaden conservatively.
- Docs, data, assets, templates and spawned executables select actual declared readers. Explicit no-reader claims require independent verification and cannot suppress scanners or mandatory security obligations.
- Configuration distinguishes parsed key-domain consumers, whole-config consumers, schema/policy checks and raw-byte readers. Formatting-only changes can leave semantic readers unaffected while still selecting snapshots/raw-file consumers. Unknown keys, malformed values and unreadable/deleted configuration remain conservative.
- Native root suites and explicit fixture-data exclusions are part of discovery. File extensions alone neither prove execution nor justify omission.
- Owner/package labels describe location and responsibility, not sufficient evidence of dependency.
- Unknown input handling retains its expanded coverage even if a time budget would prefer a smaller result.

## Shared native scheduling and completion

An execution identity includes test file plus intended native configuration. Grouping preserves runner, cwd, preload/environment and package configuration/plugins. The same physical file under two required configurations represents two intended executions, not an accidental duplicate.

The native grouping and executed-identity validator are reusable independently of CI shard placement. CI may exclude root suites from test jobs only because its required build stage already executes them. Local required root obligations cannot disappear by copying that exclusion.

Verify actual native executed identities against the expanded expected set. Missing, extra, duplicate, unreadable, interrupted, signaled or configuration-mismatched completion cannot establish green proof. Native filename filtering is validated rather than assumed exact; if safe narrowing is unsupported, expand the plan to the named complete native scope before execution.

Normalize real paths within the repository for report comparison, accounting for platform aliases without permitting outside-root substitution. Empty groups do not start a runner. An empty list must never become unrestricted native discovery. Existing supervision, deadline and cancellation behavior is retained; timeout never counts as success. Progress output is observational and grants nothing.

## Local push behavior

The push adapter owns passing-record validation and comparison-base choice. First validation uses the required initial range. A subsequent compatible passing anchor on the same branch permits the complete range from that anchor to the new head, including all intervening commits. Never substitute only the newest commit.

Unresolved failed-test identities are additional push obligations until repaired. The selected union includes impact, mandatory policy and failed tests. Invalid/incomplete/stale records, another branch, rewritten history, incompatible verification context or failed reads cannot authorize narrow reuse.

Green proof requires complete expected execution and unchanged tested head/tree/verification inputs. Relevant selector semantics, input declarations, runner/configuration, dependency installation and environment changes invalidate incompatible proof. Ordinary subject-source edits or a regenerated per-head graph must not invalidate all reuse merely because the overall tree differs.

Compute full selection lazily when fallback is actually needed. Do not construct the full branch graph just to display a counter before doing a valid incremental selection. An unavailable diagnostic count is explicit and never invented.

Passing records under an older incomplete model do not prove new-model coverage. Activation starts with a new valid baseline. Deferred and storage publication paths do not write or consume passing-test proof. They remain distinct from an executed local pass.

The completed selected-suite result and driver-owned explicit Test Plan receipts are the existing result authority. Evidence composition executes no tests. Its selected-suite command names the immutable identities/configurations actually run; it does not recalculate from a subsequently advanced anchor or an overwritten last-plan file. Local initial and repair publications, and later Evidence refresh, must not accidentally run the selected suite again. Different command/cwd/preload/environment contexts are not equivalent merely because their test-file lists overlap.

Zero feature impact may still require mandatory tests. When no tests are required, Test Plan and Evidence represent that state faithfully and do not claim a successful test execution. An explicit approved command remains an obligation even when automatic selection is empty.

## CI behavior

The CI adapter chooses PR comparison base and exact candidate/tested tree. A PR head and a tested merge tree are recorded distinctly when they differ. For identical comparison, inventory and policy, local and CI dependency-required identities match; platform/configuration and mandatory-policy differences are explicit additions.

CI adds required builds, typechecks, lint, real committed-configuration probing and required sandbox/policy work with their prerequisites. Test impact alone is not a complete CI plan. A zero-test plan can still require governance or other verification.

Keep existing required job names, build-only test/sandbox dependencies and current-head recovery assumptions unless separately revised. Planning within the existing build does not add a new queue/dependency stage. Native execution and aggregate coverage account for every required planned group exactly once per intended configuration. Missing plans/results, stale identities, failures, cancellations and unexplained skips refuse completion.

The real configuration probe runs against committed refs under its existing guarded, credential-free context, outside ordinary test preload. A green isolated fixture suite is not proof that an ambient candidate configuration was loaded. The production trust-anchor guard is not broadened to make local benchmarking convenient.

Inventory/root safety verification and existing mandatory obligations remain until their modeled inputs and independent tests justify precision. Main retains full required verification. Advisory macOS sandbox work remains advisory and does not acquire merge authority through the plan.

Changes to planning/graph/input/runner/workflow machinery take a conservative verification path under the existing base-revision guard design. A PR-controlled workflow is not self-authenticating; review and full-main verification remain backstops. Neither selector output nor this specification asserts branch rules that the forge has not configured.

## Independent correctness and performance acceptance

The selector is exercised against at least two differently structured fixture repositories without engine edits. Deterministic input replay, equivalent local/CI-policy selection, base/head deletion/rename cases, raw/semantic config readers, spawned programs, root/scanner coverage, unknown fallback and read-only behavior are explicit tests.

Expected coverage comes from independently specified cases and actual full fixture execution, not the planner's own output. Remove a required edge and require the oracle to catch the omission. At CI-task level independently specified missing build/typecheck/probe/sandbox/security obligations must also be rejected; import graphs and task-tool dry runs alone are not an oracle for all readers or policy.

Native adversarial cases include filename substring collisions, missing/extra/duplicate execution, configuration differences, fixture-shaped data, empty groups, interrupts and deadlines. Push integration exercises real initial, incremental, unchanged, failing, retry, repair and shared-dependency publications, plus Engine/standalone Evidence and current-head CI completion.

Reconstruct the original broad docs/config/barrel workloads and compare archived and new implementations on identical inputs under controlled conditions. Record selected identities and reasons, required failures caught, selection cost, checks/typecheck, test execution, explicit-command work and whole publication/CI latency separately. Repeat measurements; retain raw commands, immutable inputs and results. Small fixture milliseconds establish mechanism behavior, not production wall time.

Accurate selection and reuse must demonstrate the benefit. There is no universal latency or mathematically complete minimality promise. Necessary additional coverage is reported honestly when correcting old underselection. Expensive genuinely required work remains required.

## Compatibility and activation

Default adopter behavior remains compatible. Repository-specific inventory/native support is explicit; a mixed-native plan never reaches a Bun-only runner during an intermediate merge. Selection can ship read-only before execution wiring exists.

Changing the trusted default-branch ready-tests policy affects running drivers on subsequent publications. Coordinate existing drain/resume procedures and compatible builds before activation. A task-branch-only config edit cannot activate itself. Activate local ready/repair validation only after real-hook correctness and representative performance acceptance; preserve mandatory policies and existing CI verification. Reverting the activation setting can restore the prior deferral mode without discarding the new architecture.

Separate package publication is optional future work. Moving folders or publishing a library is not, by itself, a performance improvement.
