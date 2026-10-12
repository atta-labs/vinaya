# Evaluation harness — contracts and estimators

Status: draft

The evaluation program (`apps/cli/specs/dev-review-evaluation-program.md`) defines four harness ports — Task, Trial, Grader, Report — and the statistics reported over them (its §3, §7, §8, §9 and §11). This file describes the code that implements those contracts and estimators, `apps/cli/src/lib/dev-review-eval/contracts.ts` and `apps/cli/src/lib/dev-review-eval/estimators.ts`, the module registry the program's §6 requires, `apps/cli/src/lib/dev-review-eval/registry.ts`, and the trial staging and contamination test its §11 requires, `apps/cli/src/lib/dev-review-eval/staging.ts` and `apps/cli/src/lib/dev-review-eval/contamination.ts`. Vocabulary is the evaluation program's §3, used exactly.

Nothing here runs an agent or decides acceptance. Those come later; this layer gives them typed values to exchange, pure functions to compute what a report shows, and a clean, proven-isolated workspace for each trial.

## Not shipped

The harness is internal tooling. No CLI entry, command or other library module imports it — only the harness itself and tests do. `apps/cli/tests/eval/not-shipped.test.ts` walks every source file in the repository, reads its imports with the TypeScript compiler's pre-processor (static imports, re-exports, `import()` and `require`), and fails on any importer outside `apps/cli/src/lib/dev-review-eval/` and the tests. Because the published CLI bundles only what its entry reaches, nothing of the harness ships.

## Contracts

Every value crossing a port is plain data. Each has a validator returning either `{ ok: true, value }` or `{ ok: false, refusal }`, where the refusal carries a typed `code`, the dotted `path` of the offending field, and a one-line `detail`.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/contracts.ts contains:export type Validated<T> = { ok: true; value: T } | { ok: false; refusal: ContractRefusal } -->

Digests are SHA-256, written as 64 lowercase hexadecimal characters; commits are 40 lowercase hexadecimal characters; identifiers (task ids, suite names, conditions) are stable lowercase kebab names.

### Grader

A grader is pinned logic scoring one aspect of a trial's outcome.

- A **code grader** is pinned by `id`, `version` and `logicDigest`.
- A **model grader** is pinned by every element the evaluation program's §7 names: `id`, `version`, `adapterVersion`, `cliVersion`, `model`, `promptDigest`, `outputSchemaDigest`, `calibrationCorpusDigest`. A missing element is refused.
- A verdict is `pass`, `fail` with a reason, or `unknown` with a reason. A code grader returning `unknown` is refused (`unknown_from_code_grader`); a `fail` or `unknown` without a reason is refused (`reason_required`).
- The `Grader` port is `{ identity, grade(outcome) }`: it receives the trial's recorded outcome, never what the agent said happened.

### Task

One test case: `id`; `kind` (`coding` or `non-coding`); fixed `inputs` (repository commit, brief digest, staged-input digests, scripted-environment digest or `null`); the pinned `environmentBuilder`; the `referenceSolution` (required for a coding task — refused as `reference_solution_required` otherwise); its `graders`; and the `pinning` record of the evaluation program's §9 (repository commit, brief digest, staged-input digests, reference-solution digest, expected-outcome digest, graders with their pinned identities).

The pinning record restates the task. Any disagreement between the two — a different commit, brief, staged input or reference solution, a grader the task runs that is not pinned at the same identity (`grader_not_pinned`), or a pinned grader the task does not run — is refused as stale.

### Trial

One isolated execution of one task under one condition: `id`, `taskId`, `condition`, `attempt` (from 1), `scope`, `isolation`, `outcome` and `transcriptDigests`.

- **Scope** is `whole`, a single `node`, or a `section` from one node to another — the partial-execution shape graph conformance tests use. A runner that has no graph only ever records `whole`.
- **Isolation** names the trial's workspace, vendor home, checkpointer and Log destination. `validateTrialSet` refuses two trials sharing any of them (`shared_isolation`) — every trial starts clean, with its own fresh checkpointer — and refuses a repeated (task, condition, attempt).
- **Outcome** is `graded` (the outcome digest plus one result per grader) or `errored` with a reason.
- `trialVerdict` reads a trial as `pass` only when every grade passes, `fail` when any grade fails or the trial errored, and otherwise `unknown`, which must be adjudicated before it is counted.

### Suite

A named, versioned set of tasks: stable `name`, `version` (from 1), `layer` (`L1`–`L8`, the evaluation program's §5), `kind` (`capability` or `regression`), and `splits` — `development` and `heldOut` task ids, disjoint (`splits_overlap`), without repeats, and not both empty.

Splits are fixed at creation. `createSuite` returns a deeply frozen suite, and `validateSuiteRevision` refuses a suite with the same name and version as a recorded one whose splits differ (`splits_changed`). Changing the splits needs a new version.

### Report

What a run reports: the suite's name and version; the `split` it ran on; one entry per `condition` with per-task tallies (successes out of trials), the per-suite mean, its interval, the resampling inputs it was computed with, and any pass^k values; the `paired` comparison or `null`; the `quarantined` tasks; and the transcript digests. The validator refuses an interval that does not contain its estimate, a pass^k for a k above any task's trial count, a severe regression not also listed as a regression, a paired comparison naming an unreported or identical condition, and a task that is both estimated and quarantined.

## Estimators

Every estimator is a pure function: equal inputs give equal outputs. Each returns `{ ok: true, value }` or a typed refusal.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/estimators.ts contains:export type Estimate<T> = { ok: true; value: T } | { ok: false; refusal: EstimatorRefusal } -->

- **Per task:** `tallyTask` counts successes c out of n trials. An `unknown` verdict is refused (`unadjudicated_unknown`) — it is adjudicated first.
- **pass^k:** per task C(c, k) / C(n, k), computed as the product of (c − i) / (n − i) for i from 0 to k − 1; averaged over tasks by `passHatK`. Refused when any task ran fewer than k trials (`trials_below_k`) or k is not a positive integer.
- **Per-suite mean:** `suiteMean` returns the mean per-task success rate, the task count and a bootstrap interval over tasks.
- **Paired regressions:** `pairedRegressions` takes two conditions over the same tasks with the same trial count per task (otherwise `task_sets_differ` or `trial_counts_differ`). A task is a paired regression when the candidate succeeds on fewer trials than the baseline, and a severe paired regression when the baseline succeeds on every trial and the candidate on none.
- **Paired comparison:** `pairedComparison` adds the mean per-task difference (candidate minus baseline) with a paired bootstrap interval over tasks. It is an estimate only; deciding acceptance is not its job.
- **Quarantine:** `separateQuarantined` splits tallies into estimated and quarantined, every task landing in exactly one list, with the quarantined count. A quarantine naming a task with no tally is refused, so no task disappears.

### Randomised estimators take every random input explicitly

No default method, seed, resample count, confidence level or threshold is built in: the evaluation program freezes those values in a later milestone, and the estimators take them as the `Resampling` input `{ method, seed, resamples, confidence }`, echoed back in the result.

- **Generator:** Mulberry32 seeded with the 32-bit unsigned integer `seed`.
- **Resampling:** resample r draws n task indices ⌊u · n⌋ with replacement from one stream, consumed in resample order (`resampleIndices`). A paired bootstrap resamples tasks, keeping each task's pair together.
- **Quantile:** linear interpolation between order statistics, q(p) at position (m − 1) · p of the m sorted resampled means.
- **Methods**, with θ̂ the point estimate and α = 1 − confidence:
  - `percentile` — [q(α/2), q(1 − α/2)];
  - `basic` — [2θ̂ − q(1 − α/2), 2θ̂ − q(α/2)], clamped to the estimate's range.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/estimators.ts contains:export const BOOTSTRAP_METHODS = ['percentile', 'basic'] as const -->

`apps/cli/tests/eval/estimators.test.ts` checks each method, pass^k and the paired estimates against values computed by hand from pinned resample indices.

## Module registry

The evaluation program's §6 requires every migrating component to carry a recorded evaluation with ten fields — contract, owner, official basis, suite, tasks, grader, backends, decision rule, cadence and migration gate — collected in one module registry. `registry.ts` holds its types, validation, shard aggregation and shard completeness; the data lives under `apps/cli/tests/eval/registry/`.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/registry.ts contains:export const REQUIRED_FIELDS = [ -->

### Rows and their sources

- **The catalog**, `modules.json`, has one entry per §6 module, `6.1` to `6.24`. Each entry states all ten fields and the suites it declares — one per layer its §6 entry lists, as a stable name and a version (`run-preparation.l1`, version 1), never a test file. `6.19`, the Planner, is listed so its absence is a decision: it is the one entry marked `excluded` with its reason, it declares no suite, and only an excluded entry may state a field as `notApplicable`.
- **A component row** names its `kind` (port, node, role, tool, gate, transition, effect, adapter, isolation boundary, product guarantee, fault or attack, or cutover gate), an id `<kind>:<name>`, exactly one catalog module, and the ten fields, every one stored on the row. Copying a module's value is allowed; leaving a field to be inherited is not. Its `suite` field names only suites its module declares, as `<name>@<version>`.
- **Tasks** state each of the five cases — positive, negative, refusal, recovery, adversarial — as `{ present }` or `{ notApplicable }` with the reason.
- **Owner, backends, cadence and grader kinds** take the program's own vocabulary: owners `engine`, `vinaya-policy`, `adapter`, `sandbox`, `governed-effect`, `process-package`; backends `standalone`, `engine`; cadences `every-affected-change`, `scheduled-live`, `pre-release`, `canary`; grader kinds `code`, `model`, `human`.
- **Every row carries its own source**: the document, its revision and a heading in it. A catalog entry cites its `### 6.n` heading of `apps/cli/specs/dev-review-evaluation-program.md` at the mirror's pinned revision; a component row cites the document that states it.

A pending number is written with the program's own marker — a floor marked *Principal*, a margin from the milestone-3 paired pilot — never left blank.

### Validation

Validation returns the value or `{ ok: false, refusal }` with a typed `code`, the dotted `path` of the offending field (prefixed by the file and `#` when it came from one) and a one-line `detail`. It refuses a missing field (`missing_field`), an empty one (`empty`), a placeholder such as `TBD`, `N/A` or `…` (`placeholder`), a value outside the vocabulary (`unknown_value`), an unknown module (`unknown_module`), the excluded module (`module_excluded`), a suite the module does not declare (`unknown_suite`), and a component field stated as not applicable (`not_applicable_refused`).

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/registry.ts contains:export type RegistryResult<T> = { ok: true; value: T } | { ok: false; refusal: RegistryRefusal } -->

### Shards and aggregation

Component rows live in shard files under `apps/cli/tests/eval/registry/shards/`. Each shard names itself after its file and declares the component kinds it covers; a row of any other kind is refused (`kind_not_declared`). `readShardDirectory` finds the shards by listing that directory — every `.json` file, in name order — so a later shard is a new file and touches nothing shared. `aggregateShards` validates each shard against the catalog and joins their rows; a component id that appears twice, within one shard or across two, is refused (`duplicate_component`) naming both locations, as `shards/<file>.json#components[<n>]`. `loadRegistry` reads the catalog and the directory and does both.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/registry.ts contains:export function readShardDirectory( -->

### Shard completeness

`checkShardCompleteness` compares one shard with the universes its caller derives, for the kinds that shard declares and no other: it reports every universe member with no row (`missing`), every row naming no member or repeating one (`extra`), and every row validation refuses (`invalid`). A declared kind with no derived universe is refused rather than passed. It is a per-shard check, not the program's global exit check over every component.

The first shard, `typed-sources.json`, covers the kinds a typed repository source already enumerates, and `apps/cli/tests/eval/registry-typed-sources.test.ts` derives each universe from that source rather than listing it:

| Kind | Universe | Typed source |
| -- | -- | -- |
| `port` | `ports` | `apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json` |
| `node` | `ENGINE_STATES` and `NODE_CONTRACTS` | `apps/cli/tests/lib/dev-review-loop/dev-review-engine-state-contract.fixture.ts` |
| `transition` | `ENGINE_TRANSITIONS` | the same fixture |
| `product-guarantee` | register entries classified `product-guarantee` with `product` scope | `apps/cli/tests/fixtures/dev-review-architecture-invariants.json`, re-pinned to Engine revision 17 |

Each row's owner is its typed source's owner read into the program's vocabulary — `engine-runtime` is `engine`, `provider-adapter` is `adapter`, `governed-operation` is `governed-effect`, and `vinaya-policy`, `log` and `operator-control` are `vinaya-policy`, since the capability matrix gives Vinaya the Log and the Operator controls; ports and transitions are `vinaya-policy`, which the matrix names as owner of the five core ports and the legal transitions. Each row cites a heading of its source document at that revision, and the test checks the heading exists. The shard says nothing about roles, tools, effects, adapters, isolation boundaries, gates, faults or attacks; later shards add them.

The second shard, `contract-kinds.json`, covers the kinds stated in the contract specifications and typed tool lists. `apps/cli/tests/eval/registry/contract-kinds-universe.ts` derives each universe from its source, and refuses when two sources that state one universe disagree:

| Kind | Universe | Source |
| -- | -- | -- |
| `role` | the grant table's roles | `apps/cli/specs/dev-review-capabilities-contracts.md` §3 |
| `tool` | `DEV_TOOL_NAMES`, matched against the §4.1 table; the planned `read_source` of §4.2; `TASK_TOOL_NAMES`, the Operator's five tools and its pull-request read | `apps/cli/src/lib/task-tools/dev-tools-server.ts`, `packages/aeg-core/src/task-tools.ts`, the contracts specification |
| `effect` | each §4.1 tool marked as a write, and the controller's own publications named in the evaluation program's §6.12 and §6.13 | the contracts specification and the evaluation program |
| `adapter` | `adapters` | `apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json` |
| `isolation-boundary` | the six rows of the boundary table | `apps/cli/specs/isolation.md` §1 |
| `gate` | the workflow-gate list | the contracts specification §7 |

Each row cites the section that states its component: an evaluation-program section at the mirror's revision, and any other specification at the Engine revision the register is pinned to. The `read_source` row says it is planned, not live. `apps/cli/tests/eval/registry-contract-kinds.test.ts` fails on any missing, extra or invalid row, and checks that the shard aggregates with the others without a duplicate id.

`apps/cli/tests/eval/registry.test.ts` checks the catalog against the mirror — one entry per `### 6.n` heading, the ten fields of its table in order, one suite per listed layer, the mirror's revision — and every refusal above; the typed-sources test prints the per-kind counts and fails on any missing, extra or invalid row.

## Trial staging

The evaluation program's §11 "Repository isolation" requires every trial to start clean, proven mechanically before any model process starts. `staging.ts` stages a trial; `contamination.ts` tests it, admits or refuses it, and, after the trial, attributes what it created and builds the grading copy. Neither runs an agent, and neither touches the product's own linked-worktree mechanism, which adapter conformance proves separately.

Every harness git process runs with a fixed environment: system, global and XDG configuration off, no home directory and no inherited `GIT_*` variable. No operator setting reaches a staged repository, and the operator's own home and vendor state are never read.

### Staging

`stageTrial` takes a trial id, the source repository, the base commit, a parent directory and a mode, and creates the trial's own directory holding the workspace and the agent state.

- **Clone** — for a role that needs git. A non-local clone (`git clone --no-local --no-hardlinks`, the regular git transport, so no object file is shared or hard-linked) of exactly the history leading to the base commit (`--revision`, which needs git 2.49 or later), with no tags and no templates. Staging then creates the one task branch at the base commit, points `HEAD` at it, removes the configured remote and deletes every reflog the clone wrote. It is never a linked worktree of the operator's repository.
- **Snapshot** — for a role that needs no git metadata, such as a reviewer. The base commit's tree written byte for byte from its blobs read with `git cat-file --batch`, with no filters applied: regular and executable files, symlinks, and a gitlink as an empty directory. There is no `.git`.
- **Agent state** — the vendor home, session store, transcripts, tool state, cache and temporary directory, each created empty for this trial, recorded with the device and inode it had when created.

The source repository is only read.

### The allowed-object manifest

Before staging creates the workspace, the controller freezes the allowed-object manifest from its declared starter input, the base commit, reading the source repository and not the clone it will judge. For a clone it is every object `git rev-list --objects` reaches from the base commit; for a snapshot it is the base commit's tree, every entry with its mode and blob id. The manifest is deeply frozen and carries a SHA-256 digest over its sorted contents. Objects a trial later creates are never admitted to it.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/staging.ts contains:export function freezeObjectManifest(source: string, baseCommit: string): Readonly<AllowedObjectManifest> { -->

### The contamination test

`testContamination` collects every finding rather than stopping at the first, each with a typed `code`, its `subject` and, for objects, the complete list of offending ids. It compares complete sets and never samples. A clone is refused unless every check below holds:

| Check | Refused as |
| -- | -- |
| The workspace `.git` is a directory of its own, with no `commondir` or `worktrees` | `linked_worktree` |
| The set of every object — loose objects read from the directory, packed ones read from every pack index with `git show-index`, and any further object `git cat-file --batch-all-objects` sees — equals the manifest, in the manifest's object format | `object_set_mismatch` |
| The object store holds nothing but loose objects and complete packs | `stray_object_file` |
| `git fsck --full --unreachable --no-reflogs` succeeds and lists no unreachable object | `integrity_check_failed`, `unreachable_object` |
| No ref exists but the task branch — no tag, remote-tracking ref, replacement ref or note — and it points at the base commit, with `HEAD` on it | `foreign_ref`, `task_branch_moved`, `head_not_task_branch` |
| No pseudo-ref such as `ORIG_HEAD` or `FETCH_HEAD` | `pseudo_ref` |
| Every reflog is empty | `reflog_not_empty` |
| No alternates; no promisor remote, partial-clone extension or promisor pack; no grafts; no shallow boundary | `alternates`, `promisor`, `graft`, `shallow` |
| No remote is configured, in configuration or in the legacy `remotes/` and `branches/` files, nothing is included, and the local configuration sets only what a fresh repository needs | `remote_configured`, `config_include`, `unexpected_config` |

A snapshot is refused when any `.git` exists anywhere in it (`git_metadata_present`) or its files differ from the base tree by path, mode or content (`snapshot_mismatch`). For either kind, every agent state directory must still be the directory staging created and still empty (`prior_agent_state`), and no hidden input may be visible (`hidden_input_visible`): not in the manifest, not in the object database, and not anywhere in the trial's directory, byte for byte under any name. An empty hidden file is indistinguishable from any other empty file and is not compared. A clone git cannot read is refused, never admitted.

`admitTrial` runs the test and calls the trial's start function — the only way its model process is launched — when, and only when, the test is clean; otherwise it returns the report as the refusal and the start function is never called.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/contamination.ts contains:export function admitTrial<T>( -->

### Hidden inputs and the grading copy

A task's hidden fail-to-pass tests and its reference solution are given to the contamination test only so it can prove them invisible; nothing writes them into the trial's directory. After the trial, `attributeTrialObjects` checks every object outside the manifest: it is attributable to the trial when it lives in the clone's own store — a loose object, or a pack staging did not leave — written after staging froze the manifest, and is not a hidden input. Each is refused otherwise, as `foreign_source`, `in_staged_pack`, `predates_trial` or `hidden_input`. The report also separates the created objects the task branch reaches beyond the base commit from those nothing reaches, and lists any manifest object no longer present. For a snapshot it lists the files that differ from the base tree, the base files the trial deleted, and refuses any file whose content is a hidden input.

`prepareGradingCopy` builds a separate copy, outside the trial's directory, only for a trial whose every created object is attributed: for `fail-to-pass`, a non-local clone of the task branch with the hidden tests written in; for `reference-solution`, the base commit with the reference solution and the hidden tests written in. The copy has no remote, a hidden path may not leave it or enter `.git`, and the trial's own clone is only read. A hidden input is never written through a symlink the trial left: every directory on its path must be a real directory, the file must be absent or a regular file and is opened without following links, and grading is refused otherwise.

### What the test proves

`apps/cli/tests/eval/staging.test.ts` runs real git in a temporary directory it removes afterwards. A clean clone and a clean snapshot pass, and the clone shares no inode with the source and leaves the source unchanged. Each planted contamination is refused with its own code: a later commit's object, loose and packed; a missing object; a tag; a remote-tracking ref; a replacement ref and a note; a moved task branch and a detached `HEAD`; a pseudo-ref; a reflog entry; an alternates file; a promisor remote and a promisor pack; a graft; a shallow boundary; a configured remote, in configuration and in the legacy files; an include and an unexpected setting; a linked worktree; a stray object file; prior vendor state, as a leftover file or a replaced directory, in each agent state directory; and a visible hidden test or reference solution in the working tree, the object database, agent state or the base history. It also proves attribution, the refusal to grade an unattributed trial, and that hidden inputs reach the grading copy alone, even when the trial committed a symlink on a hidden input's path.

## Failure taxonomy

The evaluation program's §9 asks for 20 to 50 representative failures from real loop history, each with its first failure, grouped into a taxonomy that the defect register seeds, before any live suite is frozen. This section describes that taxonomy and the frozen input it is built from. It is not a live suite: it stages no task, runs no grader and changes no harness source.

### The frozen bundle

`apps/cli/tests/eval/failure-taxonomy/bundle.jsonl` is the historical input, in JSON Lines: one record per forge comment, holding the pull request's number, title, closing Issues, state and merge time, and the comment's id, creation time, author and raw body. A dispatched Developer cannot read the forge, so the history was exported once, as twenty comments on a separate data Issue, and the bundle is those comments' bodies concatenated in their pinned order, byte for byte: never reformatted, sorted or re-encoded.

`apps/cli/tests/eval/failure-taxonomy/bundle-manifest.json` records its provenance: the repository and data Issue; each source comment's id, byte count and SHA-256, in order; the total byte count and the complete SHA-256; the export window; the selection rule; and the pull-request and record counts. The window takes the newest 500 pull requests created between its two dates. The rule keeps those whose head branch starts with `task/` and that reached a second Developer round or carry a loop pause or a Principal ruling, and from each it takes every comment carrying a loop, Developer-round or Principal-ruling marker, oldest first, pull requests in number order.

### The taxonomy

`apps/cli/tests/eval/failure-taxonomy/taxonomy.json` is built from the bundle alone. Every loop pause and Principal ruling in it was read, the failures were open-coded, and the codes were grouped into categories ([Husain and Shankar](<https://hamel.dev/blog/posts/evals-faq/>)). Each category carries a definition. Each failure task carries its pull request and Issue, the bundle comment ids it rests on, its first failure and one category. The first failure is the earliest point in the run where it went wrong, not the round where the loop noticed it: a pause caused by telemetry overflowing a forge read is recorded as the telemetry published where the loop reads, not as the read.

The `registerSeed` list accounts for every defect in the invariant register (`apps/cli/tests/fixtures/dev-review-architecture-invariants.json`) by id: it maps the defect to the category its failure belongs to, or states why the bundle cannot show it — most often because the defect lives in Log events or host state, and the bundle holds forge comments only.

### What the test proves

`apps/cli/tests/eval/failure-taxonomy.test.ts` fails when:

- the bundle's bytes disagree with the manifest's total, complete digest or any chunk's byte count and digest, read in order;
- a record lacks the manifest's fields, or the record or pull-request counts drift;
- the taxonomy holds fewer than 20 or more than 50 tasks, a task cites a comment id the bundle does not hold or one from another pull request or Issue, a category has no task or no definition, or a task names an unknown category;
- a register defect is missing from the seed, appears twice, or a seed entry names an id the register does not hold, maps to an unknown category, or neither maps nor gives a reason.

### Not part of this foundation

Deeper trace review is ongoing work (the evaluation program's §16), not part of this foundation. The bundle holds only forge comments; agent transcripts and Log events are not in it, so a failure visible only there is not in this taxonomy, and several register defects are marked as not observed for that reason.
