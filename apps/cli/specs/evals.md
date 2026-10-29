# Evaluation harness — contracts and estimators

Status: draft

The evaluation program (`apps/cli/specs/dev-review-evaluation-program.md`) defines four harness ports — Task, Trial, Grader, Report — and the statistics reported over them (its §3, §7, §8, §9 and §11). This file describes the code that implements those contracts and estimators, `apps/cli/src/lib/dev-review-eval/contracts.ts` and `apps/cli/src/lib/dev-review-eval/estimators.ts`, the module registry the program's §6 requires, `apps/cli/src/lib/dev-review-eval/registry.ts`, and the trial staging and contamination test its §11 requires, `apps/cli/src/lib/dev-review-eval/staging.ts` and `apps/cli/src/lib/dev-review-eval/contamination.ts`, and the process-neutral layer G — `neutral-case.ts`, `neutral-outcomes.ts`, `generic-graders.ts` and `banned-terms.ts` in the same directory, with `vinaya-renderer.ts` mapping it to and from the Vinaya process. Vocabulary is the evaluation program's §3, used exactly.

Nothing here runs an agent or decides acceptance. Those come later; this layer gives them typed values to exchange, pure functions to compute what a report shows, and a clean, proven-isolated workspace for each trial.

## Not shipped

The harness is internal tooling. No CLI entry, command or other library module imports it — only the harness itself and tests do. `apps/cli/tests/eval/not-shipped.test.ts` walks every source file in the repository, reads its imports with the TypeScript compiler's pre-processor (static imports, re-exports, `import()` and `require`), and fails on any importer outside `apps/cli/src/lib/dev-review-eval/` and the tests. Because the published CLI bundles only what its entry reaches, nothing of the harness ships.

## Contracts

Every value crossing a port is plain data. Each has a validator returning either `{ ok: true, value }` or `{ ok: false, refusal }`, where the refusal carries a typed `code`, the dotted `path` of the offending field, and a one-line `detail`.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/contracts.ts contains:export type Validated<T> = { ok: true; value: T } | { ok: false; refusal: ContractRefusal } -->

Digests are SHA-256, written as 64 lowercase hexadecimal characters; commits are 40 lowercase hexadecimal characters; identifiers (task ids, suite names, conditions) are stable lowercase kebab names.

### Grader

A grader is pinned logic scoring one aspect of a trial's outcome.

- Every grader declares its **layer**, `G` or `P`. A layer-`G` grader reads only process-neutral facts — a neutral case and its neutral outcomes (see "Layer G" below). A layer-`P` grader reads an artifact one process owns, such as Vinaya's frozen brief, a reviewer severity or a structured turn result. An identity that declares no layer, or any other value, is refused. This tag is not a suite's `L1`–`L8` layer; an L5 or L6 suite carries it separately, as its `processLayer` in the module registry. Every grader of the Developer capability, reviewer-quality and tool-selection suites is `P`.
- A **code grader** is pinned by `layer`, `id`, `version` and `logicDigest`.
- A **model grader** is pinned by its `layer` and every element the evaluation program's §7 names: `id`, `version`, `adapterVersion`, `cliVersion`, `model`, `promptDigest`, `outputSchemaDigest`, `calibrationCorpusDigest`. A missing element is refused.
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
- A layer-`G` trial of the Vinaya process is graded on outcomes the Vinaya renderer extracts, and its trial record carries the renderer version it was rendered and extracted under (see "The Vinaya renderer"). A result reported from such trials names that version too (see "Development-only step-one run and freeze record").

### Suite

A named, versioned set of tasks: stable `name`, `version` (from 1), `layer` (`L1`–`L8`, the evaluation program's §5), `kind` (`capability` or `regression`), and `splits` — `development` and `heldOut` task ids, disjoint (`splits_overlap`), without repeats, and not both empty.

A suite that runs real agents on tasks — an L5 or L6 suite — also has a **process layer**, `G` or `P`, declared beside it in the module registry: `G` when its graders read only process-neutral outcomes, `P` when they read one process's artifacts. Only layer-`G` suites compare the standalone and Engine backends. The process layer is never written into `layer`.

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

- **The catalog**, `modules.json`, has one entry per §6 module, `6.1` to `6.25`. Each entry states all ten fields and the suites it declares — one per layer its §6 entry lists, as a stable name and a version (`run-preparation.l1`, version 1), never a test file. Every L5 and L6 suite also declares its `processLayer`, `G` or `P`, and a module may declare one L5 suite of each: the Developer capability, code reviewer, security reviewer and source citation modules declare their existing L5 suites `P` and a `-neutral` suite `G` beside each (`developer-capability-neutral.l5`); tool selection, Vinaya's own role catalog, has only its `P` suite; the whole loop's `whole-loop.l6` is `G`, since its backend comparison runs on layer-`G` suites only; `operator.l5` and `backend-selection.l6`, which judge Vinaya's own Operator and rollback, are `P`. A suite of L1–L4, L7 or L8 declares no process layer. The process renderer's `renderer-round-trip.l1` suite proves the neutral-case round trip at L1. `6.19`, the Planner, is listed so its absence is a decision: it is the one entry marked `excluded` with its reason, it declares no suite, and only an excluded entry may state a field as `notApplicable`.
- **A component row** names its `kind` (port, node, role, tool, gate, transition, effect, adapter, isolation boundary, product guarantee, fault or attack, or cutover gate), an id `<kind>:<name>`, exactly one catalog module, and the ten fields, every one stored on the row. Copying a module's value is allowed; leaving a field to be inherited is not. Its `suite` field names only suites its module declares, as `<name>@<version>`. A fault-or-attack row names its module's suites at the table's layers except a layer-`G` one: those grade process-neutral outcomes, never a fault or attack on the process.
- **Tasks** state each of the five cases — positive, negative, refusal, recovery, adversarial — as `{ present }` or `{ notApplicable }` with the reason.
- **Owner, backends, cadence and grader kinds** take the program's own vocabulary: owners `engine`, `vinaya-policy`, `adapter`, `sandbox`, `governed-effect`, `process-package`; backends `standalone`, `engine`; cadences `every-affected-change`, `scheduled-live`, `pre-release`, `canary`; grader kinds `code`, `model`, `human`.
- **Every row carries its own source**: the document, its revision and a heading in it. A catalog entry cites its `### 6.n` heading of `apps/cli/specs/dev-review-evaluation-program.md` at the mirror's pinned revision; a component row cites the document that states it.

- **Two modules or none.** A component row may carry an optional `additionalModules` list of further catalog module ids — each a live catalog module, never the row's own `module`, none repeated; a violation is refused as `unknown_module`, `module_excluded` or `duplicate`. The one-module rule stands for `module`; the list exists because a component such as an adapter is also what proves another module (`adapter:claude-code` and `adapter:codex` name `6.21`, role context delivery, and `6.25`, the process renderer). A catalog entry may carry `"scope": "system"` — a module proven by its own suites and owned by no single component (`6.18`, the whole loop); no other `scope` value is accepted.

A pending number is written with the program's own marker — a floor marked *Principal*, a margin from the milestone-3 paired pilot — never left blank.

### Validation

Validation returns the value or `{ ok: false, refusal }` with a typed `code`, the dotted `path` of the offending field (prefixed by the file and `#` when it came from one) and a one-line `detail`. It refuses a missing field (`missing_field`) — an L5 or L6 suite without its `processLayer` among them — an empty one (`empty`), a placeholder such as `TBD`, `N/A` or `…` (`placeholder`), a value outside the vocabulary (`unknown_value`) — a `processLayer` other than `G` or `P`, or one on a suite of another layer, among them — an unknown module (`unknown_module`), the excluded module (`module_excluded`), a suite the module does not declare (`unknown_suite`), and a component field stated as not applicable (`not_applicable_refused`).

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/registry.ts contains:export type RegistryResult<T> = { ok: true; value: T } | { ok: false; refusal: RegistryRefusal } -->

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/registry.ts contains:export const PROCESS_LAYERED = ['L5', 'L6'] as const -->

### Backend evidence

A fault-and-attack or cutover-gate row also carries `backendEvidence`: one entry for each backend its `backends` field lists, and no other. An entry is one of two shapes:

- **`{ "test": "<path>" }`** — the test file that proves the row on that backend, as a path from the repository root. It is accepted only when the file exists in the repository and contains the row's full registry id, `fault-attack:<order>-<slug>` or `cutover-gate:gate-<n>`, as a whole id: the short name alone does not count, and neither does a longer id the full id begins, as `cutover-gate:gate-16` begins with `cutover-gate:gate-1`. A test file is bound to a row only when it asserts the row's behaviour on that backend; a task case marked `present` declares the case and proves nothing.
- **`{ "owed": "<reason>" }`** — the proof does not exist yet, with a one-line reason. The rows owned by the Operator on one host project owe their evidence to that project and say so.

A test that runs only when an opt-in live environment variable is set — such as `VINAYA_SANDBOX_CONFORMANCE`, the sandbox conformance switch — is marked `"liveGated": { "variable": "<name>" }`. It proves its row only once the entry also records `liveProbePullRequest`, the pull request whose body carries the pasted live probe output; until then the live run is owed.

The registry refuses, when it loads: a row of either kind without `backendEvidence` or without an entry for a backend it lists (`missing_field`); an entry for a backend the row does not list, a `backendEvidence` on a row of any other kind, or a field outside the two shapes (`unknown_value`); an entry naming both a test and an owed reason, or an owed reason over more than one line (`wrong_type`); a test path that is not a path from the repository root, or a live-gate variable that is not an environment variable name (`bad_name`); a named file that does not exist (`evidence_file_missing`); and a file that does not contain the row's full id (`evidence_id_absent`). Each refusal names the row id, and a file refusal names the file. The loader reads the files from the repository by default; a caller may pass its own reader.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/registry.ts contains:export const EVIDENCE_KINDS = ['fault-attack', 'cutover-gate'] as const -->

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
| `tool` | `DEV_TOOL_NAMES`, matched against the §4.1 table; the built `read_source` of §4.2; `TASK_TOOL_NAMES`, the Operator's five tools and its pull-request read | `apps/cli/src/lib/task-tools/dev-tools-server.ts`, `packages/aeg-core/src/task-tools.ts`, the contracts specification |
| `effect` | each §4.1 tool marked as a write, and the controller's own publications named in the evaluation program's §6.12 and §6.13 | the contracts specification and the evaluation program |
| `adapter` | `adapters` | `apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json` |
| `isolation-boundary` | the six rows of the boundary table | `apps/cli/specs/isolation.md` §1 |
| `gate` | the workflow-gate list | the contracts specification §7 |

Each row cites the section that states its component: an evaluation-program section at the mirror's revision, and any other specification at the Engine revision the register is pinned to. The `read_source` row cites the built reviewer tool of §4.2. `apps/cli/tests/eval/registry-contract-kinds.test.ts` fails on any missing, extra or invalid row, and checks that the shard aggregates with the others without a duplicate id.

`apps/cli/tests/eval/registry.test.ts` checks the catalog against the mirror — one entry per `### 6.n` heading, the ten fields of its table in order, one suite per listed layer, the mirror's revision — and every refusal above; the typed-sources test prints the per-kind counts and fails on any missing, extra or invalid row.

## Global exit check

`apps/cli/src/lib/dev-review-eval/exit-check.ts` holds `checkExit`, a pure function over the aggregated registry rows and the universes the caller derives. This check, and only this check, claims the evaluation foundation's zero-uncovered exit; each shard's own check (`checkShardCompleteness`) proves completeness for its kinds alone. `apps/cli/tests/eval/exit-check.test.ts` runs it in continuous integration, assembling the universes from each shard's own universe module; the CLI does not import it. Its explicit, row-by-row exclusion list contains only revision-14 rows owned by the **Operator on one host** project. That project owns emptying the list, and its own exit check runs with no exclusions.

It reports, by kind, the components covered, the empty fields and the unmapped components, and passes only when every one of these holds:

- every kind in the registry's `COMPONENT_KINDS` has at least one row and a derived universe, and every expected shard (`typed-sources`, `contract-kinds`, `cutover-gates`, `fault-attack`) is present;
- no component id appears twice, and no row of a kind lacks a universe member or names none;
- no required field is empty, absent or a placeholder;
- every component names a live catalog module, in `module` or `additionalModules`;
- every non-excluded catalog module is named by a component, or carries `"scope": "system"`; the excluded module (`6.19`) stays excluded;
- after the Operator-owned exclusions, the cutover gates number sixteen and the fault-and-attack rows fifty-six, each matching the mirror's table;
- every exclusion still names a mirror row, and no excluded row already has a registry row whose complete table payload matches the mirror; the test pins a 41-row ceiling so the list can shrink but cannot grow;
- the empty-field and unmapped counts are both zero.

A failure names its cause: `shard_absent`, `kind_missing`, `duplicate_id`, `empty_field`, `no_module`, `module_unnamed`, `universe_missing`, `universe_extra`, `count_mismatch`, `exclusion_stale` or `exclusion_covered`. The test plants each gap on a copy of the real data and edits no shard.

The report also gives, for the fault-and-attack and cutover-gate kinds, the Engine evidence of the rows that list the Engine backend: how many are evidenced, how many owe it, and each owed row id. A row owes it when its Engine entry is owed, or names a live-gated test with no live run recorded. Owed evidence never changes the pass result: the exit claims the registry is complete, and proof still owed is reported, not refused. The excluded rows are reported apart, as owed to the Operator on one host project, and never counted as owed Engine evidence of this registry.

### Owed Engine evidence

`apps/cli/tests/eval/engine-evidence-owed.json` lists, by full id, every row of this registry that owes Engine evidence; the Operator-owned rows are never on it. `checkOwedEngineEvidence` compares the list with the rows, and `apps/cli/tests/eval/engine-evidence.test.ts` runs it on the real data and prints the owed count. The list is shrink-only:

- an owed row missing from the list fails (`owed_unlisted`);
- a listed row that now has its Engine evidence fails until it is removed (`listed_evidenced`);
- a listed row that names no row (`listed_unknown`), is owed to the Operator (`listed_operator`) or is listed twice (`listed_twice`) fails;
- the list cannot gain a row: the test pins its ceiling at the list's current length, so a row past the ceiling fails (`list_grew`), and a row that leaves lowers the ceiling in the same change;
- a live-gated row stays listed until its entry records the pull request carrying the pasted live probe output; removing it before then fails (`live_run_unrecorded`).

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/exit-check.ts contains:export function checkOwedEngineEvidence( -->

## Layer G — neutral cases and generic graders

Layer G grades process-neutral facts in the Development Process vocabulary — Intent, Execution, Change, Evidence, Review, Decision — so the same case and the same graders can judge any process. A grader that has to parse a brief, a verdict or a severity name is layer P. Layer G reads no Vinaya artifact: its graders' input type is a neutral case plus neutral outcomes, and nothing else.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/contracts.ts contains:export const GRADER_LAYERS = ['G', 'P'] as const -->

### The neutral case

`validateNeutralCase` (`neutral-case.ts`) accepts one case or refuses it with the harness's refusal codes, naming the field. Every case carries `id`, `layer` (`G` only), `kind`, `repository`, `baseRevision`, `taskStatement`, `authorizedScope`, `deliveredDocuments` (each an `id`, a `contentDigest` and a `relevant` flag) and `grantedCapabilities`. The authorized scope carries three path-glob lists, each required and each possibly empty: `in`, `excluded` and `protected`. A path is inside the scope when an `in` glob covers it and no `excluded` glob does; a changed path outside the scope must be recorded; a `protected` path may change only when it is inside the scope. Every kind but `answer` names at least one `in` glob, and an `answer` case's three lists are all empty (`inconsistent` otherwise). Each kind adds its own fields, and a field of another kind is refused (`inconsistent`):

| Kind | What the case asks | Its own fields |
| -- | -- | -- |
| `change` | Produce a change | `hiddenTests` (path, name, `fail-to-pass` or `pass-to-pass`; not empty), `referenceSolution` (its patch digest) |
| `review` | Judge a given change | `plantedDefects` (file, kind, `blocking`, `critical`, `justified`), `changeUnderReview` (base, head, patch digest; its base is the case's base), `adjudication` (`clean` and at least two adjudicators) |
| `loop` | Take a task through change, evidence and review to a decision | `hiddenTests`, `referenceSolution` |
| `answer` | Reply using the delivered documents, producing no change | none: no hidden tests, reference solution or change under review |

A review case adjudicated clean carries no planted defect and names at least two adjudicators; one not adjudicated clean carries at least one planted defect, which is what shows it is not clean, and may name no adjudicator. The task statement must pass the banned-terms checker below (`banned_term`).

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/neutral-case.ts contains:export function validateNeutralCase(input: unknown): Validated<NeutralCase> { -->

`neutralCaseDigest` is the SHA-256 of the validated case's canonical JSON — every object's keys sorted — so it is the same whatever the key order and changes when any field changes. `intentVersion` is the SHA-256 of the task statement and authorized scope alone: the intent a review is bound to.

### Neutral outcomes

`neutral-outcomes.ts` types the nine facts the harness records about a trial, from the trial's environment and never from what the agent said:

| Outcome | The fact |
| -- | -- |
| `O-change` | The change's base, head and patch digest, as the published change records them and as the harness measures them, and the changed paths |
| `O-tests` | Each hidden test's result, and the revision the tests ran on |
| `O-evidence` | The checks run on one revision, under one evidence id, each required or not |
| `O-scope` | The changed paths the execution recorded as outside its authorized scope |
| `O-capability` | The capabilities the execution used |
| `O-sources` | The documents the harness holds a receipt for, by content digest, and those the agent claims it used |
| `O-review` | Each review's id, its reviewer (one stable identity per independent reviewer), the intent version and change it judged, and its findings, each at a file and blocking or not; a review approves when it reports no blocking finding |
| `O-decision` | The decision (`ready` or `not-ready`) and the evidence and review ids it rests on |
| `O-effects` | Each external effect performed, by idempotency key |

Each outcome carries a fact status: `known` (recorded and valid; only this status carries a value), `absent` (looked for where it is recorded, and not there), `unavailable` (could not be observed), `invalid` (recorded but malformed) or `inapplicable` (the fact does not exist for this kind of case).

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/neutral-outcomes.ts contains:export const FACT_STATUSES = ['known', 'absent', 'unavailable', 'invalid', 'inapplicable'] as const -->

### Generic graders

`generic-graders.ts` holds ten pinned code graders, each tagged `layer: G`, whose `grade` takes `{ case, outcomes }` and nothing else. Each first reads the outcomes it declares: one that is `absent`, `unavailable` or `invalid` — or missing, which counts as `unavailable`, or carrying an unrecognised status — fails the grade, whatever the case kind; one that is `inapplicable` fails it when the case's kind needs that fact. A grader then judges only the case kinds it applies to and passes any other kind.

| Grader | Applies to | Passes when |
| -- | -- | -- |
| `generic-hidden-tests` | change, loop | Every hidden test passes, on the measured head; a `pass-to-pass` test the runner skipped also passes, since a test gated to another platform was not broken by the change, while a skipped `fail-to-pass` test fails |
| `generic-scope-kept` | change, loop | Every changed path is repository-relative and in normal form (no leading `/`, no backslash, no empty, `.` or `..` segment); a changed path is inside the scope when an `in` glob covers it and no `excluded` glob does; no `protected` path changes unless it is inside the scope; and the changed paths outside the scope are exactly the recorded ones, so an excluded path passes only when recorded |
| `generic-capabilities-granted` | every kind | Every capability used was granted |
| `generic-documents-used` | every kind | Every relevant delivered document is claimed and has a harness receipt for its content digest, and no undelivered document is claimed |
| `generic-planted-defects-found` | review | Every planted defect with `justified: false` has a blocking finding at its file |
| `generic-clean-change-unblocked` | review | A change adjudicated clean draws no blocking finding |
| `generic-review-bound` | review, loop | At least one review, each bound to the case's intent version and to the change (the change under review, or the measured change) |
| `generic-decision-bound` | loop | The decision is `ready`, rests on the current evidence id and exactly the current review ids, the evidence is on the head with every required check passing, at least two distinct reviewers reviewed (`APPROVING_REVIEWERS`), and every review is on the head and approves — in the Vinaya process, the loop's ready-for-merge result with both reviewers approving and every required check green |
| `generic-change-bound` | change, loop | The measured change starts from the case's base revision, and the recorded base, head and patch digest equal the measured ones |
| `generic-effects-once` | every kind | No idempotency key is performed twice |

A glob with no wildcard covers that path and everything under it; `*` matches within one path segment, `**` across segments. An `answer` case is judged by the three graders that apply to every kind — `generic-capabilities-granted`, `generic-documents-used` and `generic-effects-once`; its change, test, scope, review and decision outcomes are `inapplicable`.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/generic-graders.ts contains:export const GENERIC_GRADERS: readonly GenericGrader[] = [ -->

### Banned terms

`banned-terms.ts` holds the one list of process terms a neutral task statement may not contain: `Surface`, `objective`, `brief` and `verdict` (any case, singular or plural); every reviewer severity name as the scales write it (`BLOCKER`, `MAJOR`, `MINOR`, `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`); an objective id such as `O3`; a finding id such as `F2` or `R2-CR-3`; and the role names `principal`, `planner`, `architect`, `archivist`, `developer`, `reviewer` and `operator`. `checkTaskStatement` refuses a statement containing any of them as `banned_term`, naming the term, and accepts one free of them; `findBannedTerms` lists every term found, outside the code spans of an Interface block that ends the statement (see the layer-`G` re-cut). Severity names are matched only in capitals, so lowercase `blocker`, `major` or `minor` — and `blocking` — are accepted: banning them in any case would refuse ordinary English such as "a major release" or "low latency". A statement that names a severity in lowercase is therefore not caught here.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/banned-terms.ts contains:export function checkTaskStatement(statement: string, path = 'taskStatement'): Validated<string> { -->

`apps/cli/tests/eval/neutral-case.test.ts`, `generic-graders.test.ts` and `banned-terms.test.ts` prove each refusal, the digest's stability and sensitivity, every grader's pass on good outcomes for every case kind, its fail on every non-`known`, non-`inapplicable` status of every outcome it reads, and its rejection of a planted bad outcome.

### The Vinaya renderer

`vinaya-renderer.ts` maps between a neutral case and the Vinaya process in both directions, so the generic graders judge a Vinaya trial without reading a Vinaya artifact themselves. The renderer imports the graders' types; no grader imports the renderer.

`renderCase` validates a neutral case and renders it as Vinaya process input: a frozen brief whose `## Surface` is the authorized scope (`in:` from `in`, `out:` from `excluded` then `protected`), whose `## Documentation` lists the relevant delivered documents, and whose one objective is the task statement; the source manifest, which also delivers the documents that are not relevant, without requiring them; and each dispatched role's tool grant — the Developer for a `change` or `answer` case, both reviewers for a `review` case, all three for a `loop` case — holding the tools of the granted capabilities that role may hold: the Developer any of them, a reviewer its granted catalog tools and the `Read`, `Grep`, `Glob` and shell built-ins (`REVIEWER_BUILTINS`), never a write. An `answer` case changes nothing, so it renders as a Developer dispatch with no Surface: the process input's `surface` is `null` and the brief has no `## Surface` section; it requires no capability. A Vinaya `out:` path is beyond the Surface wherever `in:` covers it, as a neutral `excluded` path is outside the scope. Every case field is rendered, withheld (only grading reads it: hidden tests, reference solution, planted defects, adjudication) or declared inapplicable (`layer`). A case the process cannot express is refused as `unexpressible`, naming the field: a scope glob whose coverage a Surface entry cannot state — any wildcard but a trailing `/**` or the bare root glob `*`, so a wildcard inside a segment or a single-level `/*` — while a literal directory or file path, optionally followed by `/**`, and `*`, which covers the repository-root files, are written as they are; a protected glob overlapping an `in` glob, since an `out:` glob overrides `in:` where a neutral scope allows a protected path inside it; a document id that cannot be one Documentation source; a relevant document in a review case, since a reviewer reports no source use; a capability no tool exercises, or none a dispatched role may hold; a `change` or `loop` case without `publish_change` and `open_change_request`; and a task statement with a line break. An invalid case is refused as `invalid_case` with the validator's path.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/vinaya-renderer.ts contains:export function renderCase(raw: unknown): Rendered { -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/vinaya-renderer.ts contains:export const REVIEWER_BUILTINS: readonly string[] = ['Read', 'Grep', 'Glob', 'shell'] -->

`extractOutcomes` reads the nine neutral outcomes from a Vinaya trial record, which holds the process input the trial ran on and what the harness recorded:

| Outcome | Read from |
| -- | -- |
| `O-change` | The pull request's head, base and diff digest as recorded; the harness's measured change and changed paths |
| `O-tests` | The hidden-test results the grading sandbox recorded |
| `O-evidence` | The required-check result on one head, each conclusion mapped to `pass`, `fail` or `pending` |
| `O-scope` | The paths in the pull request body's beyond-Surface block; a body with no such block is `absent` |
| `O-capability` | Each traced tool name, mapped to a neutral capability by `TOOL_CAPABILITIES`; an unmapped tool is `invalid`. Claude Code's `WebFetch` and `WebSearch` map to `read_web`, a capability no case grants and no role grant holds: a web fetch reads a source nobody delivered and leaves no harness receipt, unlike `read_document`, so a trace that reaches the web fails `generic-capabilities-granted` with `capability read_web was not granted` |
| `O-sources` | The controller's counted receipts, by delivered digest, and the Developer turn result's `sourceUses`; a review case claims none |
| `O-review` | Each completed review result, its findings' severities mapped to `blocking` by `SEVERITY_BLOCKING`; a blocked review is no review; a malformed result, a crossed role or head, or an off-scale severity is `invalid`; a review bound to another brief is bound to another intent |
| `O-decision` | The loop's ready-for-merge result — both reviewers approved on the current head and every required check green; none is `absent`, no Decision |
| `O-effects` | Each governed effect, by idempotency key |

`SEVERITY_BLOCKING` is read once from each role's severity scale by rank: a severity among the scale's two most severe ranks blocks (today `BLOCKER` and `MAJOR`; `CRITICAL` and `HIGH`), the rank rule the reviewer-quality suites apply. A fact the record does not carry is `unavailable`, one it records as missing is `absent`, and a fact of another kind of case is `inapplicable`; none is ever given a passing value.

`VINAYA_RENDERER_VERSION` is the renderer's schema version and a SHA-256 over its mapping tables (the tool catalog's names among them), every render and extract function, and the whole text of every source file the mapping depends on (`MAPPING_SOURCE_PATHS`: the renderer, the neutral case and its validator, the review-result and turn-result parsers and schemas, the role grants, and the beyond-Surface reader with its helpers), so any change to the mapping changes it. Every process input and trial record carries the version it was made under, and `extractOutcomes` refuses one of another version as `stale_renderer`; every extraction returns the version it ran under.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/vinaya-renderer.ts contains:export const VINAYA_RENDERER_VERSION = rendererVersionOf(MAPPING_TABLES, MAPPING_LOGIC, MAPPING_SOURCES) -->

`apps/cli/tests/eval/vinaya-renderer.test.ts` proves each rendered section, each refusal, each mapping table and each extraction status. `vinaya-renderer-round-trip.test.ts` runs the committed cases in `neutral-cases-fixture.json` through fixture trial records: each reference solution, rendered and extracted, passes every generic grader for its kind; each known-bad variant that applies — the reference reverted, a planted protected-path edit, a planted blocking finding removed, an ungranted capability call, a relevant document left unused, an undelivered document claimed — fails the grader it targets and no other; the `answer` case's reference passes, and its unused relevant document and its claimed undelivered document each fail `generic-documents-used`; an outcome the record does not carry fails every grader that reads it; and every grader's logic digest is the same in a process that never loads the renderer. Hidden-test results in these records are recorded facts: the tests call no model and run no repository's code.

### The layer-G suites, re-cut by script

`apps/cli/tests/eval/recut-generic-cases.ts` derives the cases of five layer-`G` suites from the committed layer-`P` cases, field by field: `developer-capability-neutral.l5`, `code-reviewer-quality-neutral.l5`, `security-reviewer-quality-neutral.l5`, `source-delivery-neutral.l5` and `whole-loop.l6`. Re-running it on unchanged inputs reproduces every derived file byte for byte.

<!-- AEG:CLAIM: apps/cli/tests/eval/recut-generic-cases.ts contains:export function recutDevelopment(git: Git = repositoryGit): Recut { -->
<!-- AEG:CLAIM: apps/cli/tests/eval/recut-generic-cases.ts contains:export const REVIEWER_CAPABILITIES: readonly string[] = ['read_file', 'run_commands'] -->

- **Developer capability** — each case becomes a `change` case. The issue, pull request and brief are dropped. The scope's `in:` becomes the authorized scope's `in` and its `out:` the scope's `excluded`, each entry written as the paths the Surface entry covers (a trailing `/**` or `/*` dropped; a file path and `*` kept); `protected` is empty. Each required source becomes a relevant delivered document pinned by the SHA-256 of its content at the base commit; a web source, whose content the corpus does not hold, cannot be pinned, so it is not delivered, and the re-cut counts it in its summary. The base commit, the reference solution's digest and the hidden tests are kept: each fail-to-pass test by name, each pass-to-pass test by its name digest. The case grants the capabilities the suite's Developer holds.
- **Code and security reviewer** — each case becomes a `review` case whose scope is the changed file. Its expected defect becomes a planted one, `blocking` by its severity's rank and `critical` exactly for a seeded critical or high security defect; its objectives are dropped. It grants `read_file` and `run_commands` (`REVIEWER_CAPABILITIES`), since a reviewer reads the change with its files and with shell commands and never writes it. A historical or clean change keeps its head commit; a seeded patch's head is the commit that applies it to the base with a fixed author, committer and date (`SEEDED_COMMIT_IDENTITY`), made in a scratch object directory so it is reproducible and the repository gains nothing. A clean case's adjudicators are its two recorded adjudications. A case whose defect kind is `beyond-surface` or `objective-unmet` states a Vinaya Surface or objective, so it stays layer-`P` only, with no layer-`G` counterpart.
- **Source citation** — each development case becomes an `answer` case at the case file's repository commit, its scope empty, each source a delivered document pinned by the SHA-256 of its content with its own `relevant` flag, and `read_document` granted exactly when a source is delivered by retrieval tool. The held-out source-citation cases map the same way, from `source-citation-held-out.json` to `source-citation-generic-held-out.json`, and so every neutral suite has a held-out split.
- **Whole loop** — each developer capability case, development and held-out, also becomes a `loop` case: the same base revision, task statement, authorized scope, delivered documents, hidden tests and reference-solution digest as its `change` case, granting the capabilities the developer, both reviewers and the publication need (`LOOP_CAPABILITIES`). Its cases live in their own files, `whole-loop-generic-cases.json` and `whole-loop-generic-held-out.json`, with their own digests and held-out index; the held-out file is cut from the developer held-out cases under the developer approval. The suite's entry in each file carries a `variants` object beside its `cases` and `layerPOnly`, never inside a case, mapping each live variant to the sorted ids of the cases it applies to: `source-requiring` when a case delivers a document, and `reviewer-requested-revision` when the committed `whole-loop-revision-facts.json` records at least one review round that asked its source change for a revision. That file lists every developer capability case whose rounds were read; a loop case it does not list refuses the re-cut.

A development case's task statement is the one `generic-task-statements.json` holds for its id, committed verbatim, a developer case's followed by its Interface block (below); a missing statement refuses the re-cut. A loop case's statement is its developer capability case's, copied unchanged. A held-out case's statement is generated by the script from the case's own fields — its withheld tests' count and its scope, the file its change touches, or the count of documents a source-citation case delivers — leaving out any field that would carry a banned term. The held-out run needs the pinned digest of each of the three layer-`P` held-out files (developer, reviewer and source citation), reads each case by field, writes only the derived files and prints only case counts, ids and digests; a derived case that is not valid and renderable is reported by id and digest only, and nothing is written.

A developer capability case's statement, development and held-out, and so its loop case's, ends with the case's Interface block, so that a correct solution written independently of the reference change can pass the withheld tests. `interfaceItems` derives it from the case's fail-to-pass test files and its reference solution files, each read by its pinned blob, and the base revision's tree, parsing every source file with the TypeScript compiler API. It names each export a fail-to-pass test imports, a default import naming the module's `default` export, with that export's declared signature — the parameter list, without default values, and the return annotation as the reference source writes them, or the declaration's kind alone (`const`, `class`, `interface`, `type`) where nothing is written; a type alias's or enum's literal members; never a type the compiler infers, so a parameter with a default value is written optional, with its type only when the source annotates it — and each module the tests import that the reference change adds; then each environment variable the reference solution reads, by property, by index or by destructuring `process.env`, each `--flag` it names, each event it passes to `.on`, `.emit` or `.once`, and each field a named interface, class or object type alias declares as a direct member, with the field's written value type and the literal members of a same-file alias or enum it names, that the fail-to-pass tests also name; a type written across lines is written on one line by the compiler's printer, which keeps the member separators a line break stood for; and each string literal a fail-to-pass test passes to `expect(...)` or a matcher that the reference solution's files contain and that holds a letter. An export the base revision's module at the imported path already exports with the same signature is left out, and so is every other literal some tracked base file outside the fail-to-pass test files already contains: the base copies of the files the reference changes are checked first — a field by its parsed owner, name and type, so a type written across lines is found too — and the rest by a fixed-string `git grep -F` of the base revision, at most two hundred patterns a call; a search that fails for any reason but finding nothing refuses the re-cut. No function body, test name, exported name the tests do not import, or number is named. The block is one space, `Interface:`, then the items, each `` <kind> `<text>` `` with kind `export`, `file`, `env`, `flag`, `event`, `field` or `string`, separated by `; `, listed by kind then text, and a full stop, all on the statement's one line; a case with no item keeps its statement byte for byte. The held-out blocks are derived only once the developer approval has opened the held-out cases, and no run prints a block or any part of one. `findBannedTerms` skips the code spans of a well-formed Interface block that ends the statement, after its last ` Interface: ` marker, since a span names an identifier the tests use, and checks the rest of the statement as written.

```text
bun apps/cli/tests/eval/recut-generic-cases.ts development
bun apps/cli/tests/eval/recut-generic-cases.ts held-out --approve-developer <sha256> --approve-reviewer <sha256> --approve-source-citation <sha256>
```

`apps/cli/tests/eval/generic-suites.ts` pins each derived file by the SHA-256 of its bytes and each suite's held-out ids. Development loading never opens a held-out file; a held-out file opens only for an approval naming its pinned digest. Each suite renders its cases with the Vinaya renderer and grades them with the generic graders alone, on fixture trial records; the whole-loop suite is layer `L6`, the others `L5`. A loop case's reference record is its merged change approved by both reviewers on its head, with the evidence and the ready-for-merge decision bound to that head; besides the shared known-bad variants, a loop case is graded with one each for a review bound to another brief, a decision on stale evidence, a recorded change differing from the measured one, an effect performed twice and an unrecorded out-of-scope change, so each of its six graders is targeted. `recut-generic-cases.test.ts` proves each field mapping and that a re-run reproduces every derived file, held-out ones compared by digest only; `generic-suites.test.ts` proves, for every derived case, development and held-out, that the reference passes every generic grader and every applicable known-bad variant fails the grader it targets and no other, asserting held-out results as counts and failing ids only, and that the variant marks follow their rules, reporting the held-out marks as counts only.

<!-- AEG:CLAIM: apps/cli/tests/eval/generic-suites.ts contains:export const DERIVED_FILE_DIGESTS = { -->

### The whole-loop runner

`apps/cli/src/lib/dev-review-eval/whole-loop.ts` runs one `whole-loop.l6` case end to end through a real `vinaya task run` against the disposable sandbox repository the freeze record names (`wholeLoopSandboxRepository`), on one backend (`standalone` or `engine`, passed as `--runner standalone` or `--runner atta-engine`), one flow (`v1`, or `v2` on the Engine backend only) and one adapter (`claude-code` or `codex`, passed as `--agent claude` or `--agent codex`), and grades it with the six loop graders. Trials run one at a time, since each moves the sandbox's `main`.

```
bun apps/cli/src/lib/dev-review-eval/whole-loop.ts --case <id> --split development --backend engine --flow v2 --adapter codex --attempt 1 --sandbox <owner/name> --result <file>
```

- **Refusals, before any forge write.** The runner refuses a sandbox other than the one the freeze record names, a target of `atta-labs/vinaya`, a sandbox that is not private, a forge login without write permission to it, a sandbox that still has an open Issue or pull request from an earlier trial, `v2` on the standalone backend, a held-out case without the held-out approval, a loaded case whose repository is not the sandbox, and a sandbox that does not hold the case's base commit.
- **Loaded cases target the sandbox.** The committed cases name the repository they were cut from; `loadSandboxCases` sets each loaded case's repository to the sandbox at load time and never rewrites the committed files.
- **The trial.** The runner force-updates the sandbox's `main` to the case's base commit — both runners base the task branch and its pull request on `main` — and makes the trial clone with `git clone --single-branch --branch main --no-tags`, the sandbox its only remote. The clone must hold the base commit, no ref but `main` and `origin/main`, and no commit outside the base commit's history (`git rev-list --all` equals `git rev-list <base commit>`, evaluation program §11); otherwise the trial is refused before its Issue opens, the `main` move being its one write. The trial Issue is the renderer's brief with its Documentation lines in the Issue grammar's `- <source> — <mechanism> (O1)` form, plus `**Project:**`, `**Tier:**`, `## Parts`, `## Test plan` and `## Stop conditions`. One `task run --issue <n> --agent <agent> --runner <runner> --flow <flow>` starts with this tree's CLI, its working directory the trial clone, with `AEG_REPO` and `GH_REPO` naming the sandbox, a fresh `VINAYA_RUNTIME_DIR` and `VINAYA_LOG_FOLDER_ONLY=1`. The clone gets no `core.hooksPath`, so a `v2` ready push records `no-local-tests`, a recorded limit. A run that pauses for a ruling is stopped and recorded as paused, never as a pass.
- **The trial record**, from the forge and the clone alone: the pull request as `gh pr view --json number,state,headRefOid,statusCheckRollup,reviews,body,comments` returns it, its base the merge base of the forge's `main` and its head; the change measured on the clone's task branch; every check of the head's rollup, each counted as required; each reviewer's latest verdict comment, bound to the trial's brief when its brief hash is one frozen on the trial Issue; the ready-for-merge publication marker; the effects the comments show (the pull request opened, each Developer round marker, each publication); and the hidden tests run in a grading copy of the final head. The Developer's turn result, receipts and trace are not observed, so no loop grader reads them. The trial's pull request and Issue are then closed unmerged.
- **The result** names the case, split, backend, flow, adapter, attempt, renderer version, how the run ended, its ready-gate state (`no-local-tests`, `local-tests` or `not-reached`), each grader's verdict, the rounds, the wall time and the tokens its Log reported. A held-out case is printed by its id alone and its verdicts carry no reason.

`apps/cli/tests/eval/whole-loop.test.ts` drives the whole runner against a fake forge, a local repository as the sandbox and a fake task run, on each backend with each flow it accepts and each adapter, for a run that reaches ready-for-merge and one that stops before it; asserts each refusal and that it writes nothing; asserts the task run's environment and that every forge write names the sandbox; and builds the trial Issue body for every development case and passes it through the core Issue grammar checks.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/whole-loop.ts contains:export async function runWholeLoopTrial(options: WholeLoopOptions, deps: WholeLoopDeps): Promise<WholeLoopOutcome> { -->

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

## Tool-selection suite

The evaluation program's §6.6 asks whether each tool is selected when it should be and not when it should not, called with correct arguments, recovered from through its structured error, not confused with its neighbours, and never used to reach authority the role does not hold. `apps/cli/tests/eval/tool-selection-suite.ts` is that suite. It evaluates every tool a dispatched role is granted — the Developer's seven and the reviewers' `read_source` — on Claude Code and on Codex, and it is built on this harness: each case is a non-coding `Task`, each run a set of `Trial`s, each grade a pinned code grader's verdict, and each run's result a validated `Report`.

<!-- AEG:CLAIM: apps/cli/tests/eval/tool-selection-suite.ts contains:export const TOOL_SELECTION_FLOOR = 0.95 -->

### Cases

A case is one realistic request to one role, for one tool, in one class: `correct-selection`, `refusal`, `parameter-construction`, `error-recovery`, `neighbour-confusion` — the five classes the Engine specification names — or `unavailable-authority`. It carries the scripted world it starts from (whether the worktree holds a change, whether the branch is published, the open pull request and its reviews and failed checks, the required URLs and the reviewers' pinned sources, and any structured error a tool returns once, on its first call), what a passing trial shows, and a reference trace proving the case solvable. Each split holds one case per tool per class: 48 cases.

The scripted world is a fake controller behind the real tool dispatcher, `dispatchDevTool`, so the role grant, the strict input schema and the success-output schema are the product's own; the world adds the gates a Developer meets (the commit header, a published branch before a pull request, a body that begins by closing the task's Issue, an existing pull request) and the reviewers' paged pinned sources.

### Splits

Both splits are fixed at creation. `tool-selection-cases.json` holds the development cases and the split record: the development ids with a SHA-256 digest over the cases, and, for the held-out split, its file, the SHA-256 digest of that file's bytes, and an index of each held-out case's id, tool and class — never its content. `tool-selection-held-out.json` holds the held-out cases. Loading the case file refuses a development case changed since creation; the harness `Suite` refuses the same name and version with different splits.

Nothing but the run command reads the held-out file, and it reads it only for a run that names the pinned digest with `--approve-held-out`, or for admission. The digest and the index are checked before any held-out case is used. The tests read every file through a reader that refuses the held-out path, and prove a development run, a development admission and a case-file load never reach it. Held-out runs are approved by the Principal one at a time.

### Graders

Two pinned code graders judge every trial; no model grader is used.

- `tool-selection-trace` reads the trace — each call's tool name and arguments, a shell command as `shell`, any other built-in by its own name. It fails on any call a forbidden predicate matches, the role's own or the case's, and otherwise requires the case's required calls in order, with other calls allowed between them, so a valid alternative path is never refused for its extra steps.
- `tool-selection-state` reads the world's resulting state — pushes and the last header, pull requests opened and the body, body writes, evidence refreshes, check runs, pull-request reads, documentation reads and which counted, and source reads — and requires each stated field to meet its condition.

A role forbids what it was never granted: the Developer, shell calls to `gh`, `curl` or `wget`, `git push` and `--no-verify`, web fetching outside its tool, and `read_source`; each reviewer, every Developer tool, file writes, web fetching, and shell calls that write to git or reach the network. The tests pass every development reference trace on both adapters' transcript formats, and fail planted traces: an empty trace where a call is required, every forbidden call planted into a reference trace, a neighbour chosen in place of the tool, wrong arguments, a structured error not recovered from, the tool called where it should not be, ungranted authority through a shell command or an ungranted tool, and required calls out of order.

### The run command

```
bun apps/cli/tests/eval/tool-selection-suite.ts admit --split <development|held-out>
bun apps/cli/tests/eval/tool-selection-suite.ts run --split <development|held-out> --mode <replay|live>
  --adapter <claude-code|codex|both> --trials <n> --bootstrap <percentile|basic> --seed <n>
  --resamples <n> --confidence <x> [--approve-held-out <sha256>] [--claude-model <m>]
  [--codex-model <m>] [--timeout-sec <n>] [--out <file>]
```

`admit` replays every reference trace on both adapters and prints only counts and the ids of refused cases; it runs no agent. `run` takes every resampling input explicitly, since the evaluation program freezes them in a later milestone. It prints, per adapter, each tool's success rate against the floor with its successes, trials and task count, and the run's cost — the spend Claude Code reports, the input and output tokens each CLI reports, and wall time — and exits 0 only when every tool meets the floor on every named adapter. `--out` writes the whole result, the validated `Report` included.

- **`replay`** is the deterministic regression subset, `tool-catalog.l4`, run in continuous integration by `apps/cli/tests/eval/tool-selection-suite.test.ts`: each development case's reference trace is written in each adapter's transcript format — Claude Code's `stream-json` `tool_use` blocks, Codex's `exec --json` items — read back by that adapter's transcript reader, executed through the real dispatcher against a fresh world, and graded.

- **`live`** is the live suite, `tool-catalog.l5`. Each trial starts a fresh world behind the driver-run tool host, registered through the same channel a dispatch uses (Claude Code's `--strict-mcp-config`, a staged Codex home), serving the role only its granted tools, and runs the real CLI on the operator's subscription login in an empty workspace of its own. The trace is read from the CLI's own transcript, so an attempt the CLI denied still counts. Live runs need that login and are left to the Principal.

The decision rule is the evaluation program's §10 absolute floor: a success rate of at least 0.95 for every tool, on each adapter, on the held-out split; no margin applies.

<!-- AEG:CLAIM: apps/cli/tests/eval/tool-selection-suite.ts contains:export const LIVE_SUITE = { name: 'tool-catalog.l5', version: 1, layer: 'L5' } as const -->

## Source-citation suite

The source-citation cases of `source-delivery.l5@1` run real Claude Code and Codex sessions with native structured Developer results. The driver-run tool host delivers the case's sources, and the code grader consumes the production `RequiredSourceManifest` and `SourceDeliveryReceipt` contracts. It verifies the manifest's self-digest plus each receipt's controller provenance, round, pinned and delivered digests, revision decision and source identity before matching the accepted result's `sourceUses`. It therefore detects a missing citation, an undelivered citation, an irrelevant delivered citation, a source changed between turns, and a worker-fabricated receipt. Source-free balancing tasks must leave `sourceUses` empty.

Only a case's relevant sources are required. An irrelevant source is still in the manifest and delivered, but the prompt lists it as context and the result schema does not require it, so the task can be satisfied by citing only the relevant source. A source-mutation case runs two turns of one session: the web source changes between them, and the second turn is graded. A receipt counts under the production revision policy — a matching revision, or a changed revision of a volatile source — and only if it delivered the revision the source holds in the graded turn. A trial whose result the production parser or its semantic check refuses counts as a failure rather than stopping the run.

<!-- AEG:CLAIM: apps/cli/tests/eval/source-citation-suite.ts contains:export const SOURCE_CITATION_FLOOR = 0.95 -->
The decision rule is an absolute source-requiring-task floor of at least 0.95 pass^3 on each adapter, with every balancing trial correct. Reports name each adapter, task count, trial count, pass rate and reported spend, tokens and wall time.

`source-citation-cases.json` contains the development cases and a split record that pins both splits by digest. The record exposes only the held-out index; held-out content lives in `source-citation-held-out.json`. Development loading never opens that file. A held-out run must present the pinned digest before the file is opened, and the bytes and public index are then verified before any case runs. Prompt, tool-description and grader development uses only the development split.

The deterministic continuous-integration subset plants each evidence failure directly into the production contracts and proves the grader rejects it; it does not launch or impersonate either adapter. An approved live run launches the selected real CLI for every case and trial, records its reported usage and wall time, and uses:

```text
bun apps/cli/tests/eval/source-citation-suite.ts run --split held-out --approve-held-out <sha256> --adapter <claude-code|codex|both> --trials <n> [--claude-model <m>] [--codex-model <m>] [--timeout-sec <n>]
```

## Developer capability suite

## Development-only step-one run and freeze record

`runStepOne` orchestrates the Developer capability, code reviewer quality and
security reviewer quality development splits on both supported adapters
unless a request selects one. It accepts only the standalone backend and checks
the backend, the split, the requested suites, adapters and case selection
before loading suite inputs. A request names its purpose —
`development-only` (the default), `practice` (exactly one trial per task) or
`comparison` — and may name its suites. Comparison evidence comes only from
`STEP_ONE_COMPARISON_SUITES`, the layer-`G` developer capability, code reviewer
and security reviewer suites: a layer-`P` suite named as comparison evidence is
refused (`layer_p_comparison`), and the layer-`G` source-citation suite, which
step one admits for development-only and practice runs, is refused as
comparison evidence (`comparison_forbidden`). Each suite-and-adapter result
records task count, trials and successes per task, the seeded bootstrap suite
mean and interval, wall time, tokens, reported subscription quota use and
estimated cost, and beside them the suite's process layer (`layer`) and
`rendererVersion`: the current Vinaya renderer version for a layer-`G` suite,
an empty string for a layer-`P` suite. Every trial result carries the same two
fields beside its own usage. The usage records uncached input, output, cache
read and cache creation tokens as four separate counts, for every adapter:
Claude Code reports its cache reads and creations apart from its input, while
Codex counts its cached input inside its input figure, so step one subtracts
that cached figure to leave uncached input and records Codex's cache creation
as `0`.

A request may also select adapters and cases. The adapter selection is
`claude-code` or `codex`, both when absent; any other adapter is refused
(`invalid_input`). A case selection is a count n, the first n development cases
of each suite in its pinned order, or one or more case ids. Practice is the only
purpose that accepts a case selection: on a development-only or comparison run
it is refused (`case_selection_forbidden`) before any suite input is loaded, and
so is a count below 1 (`invalid_input`). A case id outside a selected suite's
development split is refused (`invalid_input`) before any trial runs. A
practice run that names one adapter is one invocation; a practice run on both
adapters may be one invocation per adapter.

A layer-`G` trial runs live through the Vinaya process (`executeLayerGTrial`).
The suite's development neutral case is rendered with the Vinaya renderer; the
role the rendered input names runs on the selected adapter, through the same
staging, dispatch, sandboxed commit and sandboxed hidden-test steps as the
layer-`P` Developer and reviewer trials; the trial record is assembled from what
that run recorded, and the neutral outcomes the renderer extracts from it are
graded by the generic graders alone. The trial succeeds exactly when every
generic grader passes; no layer-`P` grader judges it. Every development neutral
case has a layer-`P` case of the same id, which supplies what the neutral case
does not carry, and each kind of case runs its own way:

- A `change` case dispatches the Developer with the rendered brief and its
  delivered documents' contents, on the layer-`P` developer case of the same id,
  with no `--developer-snapshot` brief. The prompt names the issue number the
  trial's fake forge world is created with, the case's `pullRequest`, and asks
  for a pull request body whose first line is `Closes #<that number>`, as the
  real loop's brief does; the fake forge refuses a body whose first line closes
  any other number. The prompt ends with the review loop's
  own publishing instruction, `publishingInstructionLine` imported from
  `apps/cli/src/lib/dev-review-loop.ts`, so the trial tells the Developer
  exactly what the loop tells it: publish and open its own pull request through
  the driver-run tools. Its hidden tests are that case's, run in the sandbox on
  the trial's commit. The pull request the Developer opened through
  `open_pull_request` on the trial's fake forge is recorded on that commit, its
  body carrying the beyond-Surface record the review-loop driver writes; none is
  made for it, so a Developer that opens none leaves `O-change` absent and the
  trial fails.
- A `review` case dispatches the suite's reviewer on the change under review,
  the patch of the layer-`P` reviewer case of the same id, and binds its result
  to the rendered brief's hash and that change's head.
- An `answer` case runs as the source-citation suite's live trial runs, as a
  read-only turn (`readOnlyDeveloperTurn`): Claude Code holds only the served
  driver-run tools and Codex runs with a read-only sandbox. The Developer works
  in an empty workspace holding the injected documents of the layer-`P`
  source-citation case of the same id, with the others served by
  `fetch_documentation`; nothing is committed and no change is recorded.

The record's effects are the performed publication calls, each operation its
`kind` and each call's arguments its `idempotencyKey`; its tool trace is the
adapter transcript's, read by step one's own trace reader (`layerGTraceOf`),
which on the `claude-code` adapter drops Claude Code's harness-internal tools —
`StructuredOutput` (the turn-result emission), `ToolSearch` (deferred-tool
schema loading) and `TodoWrite` (the agent's own task list) — since they
exercise no neutral capability, for `change`, `review` and `answer` records
alike. None of them performs an effect, so the effects are the same; the layer-`P`
tool-selection suite's transcript readers are not changed and still see every
call. Its turn result is the Developer's raw structured output.
A trial whose case the renderer refuses, whose run fails, or whose record cannot
be extracted — one made under another renderer version among them — is
unavailable with its reason, and is never graded another way. The run is the
seam between dispatch and record: `stepOneRuntime` takes the function that runs
a rendered case and returns its trial record, production passes the real
dispatch (`runVinayaProcess`), and the tests pass fixture reference and
known-bad records, calling no model.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:export async function executeLayerGTrial( -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:export const CLAUDE_HARNESS_INTERNAL_TOOLS: readonly string[] = ['StructuredOutput', 'ToolSearch', 'TodoWrite'] -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:import { publishingInstructionLine } from '../dev-review-loop' -->

Nothing a trial's workspace controls runs on the host. Every step that runs
in or over it — the dependency install before the agent starts, staging and
committing the trial's work in its own worktree, the grading copy's install,
and the hidden and pass-to-pass test run — runs inside one `codex sandbox`
launch shape (`openGradingSandbox`): the pinned Codex CLI resolved once to an
absolute host-only path outside the scratch directory and grading copy, a policy
home staged by `stageCodexPolicyHome` from a throwaway home holding a placeholder `{}`
login and kept outside every writable root, network disabled, `/tmp` and
`$TMPDIR` excluded, writable roots limited to an empty scratch directory plus
the directory the step works on (the trial worktree and its git directory for
the commit step, the grading copy for its install and tests), and a child
environment of only `PATH`, `LANG`, `HOME` and `TMPDIR` (both the scratch
directory) and `CODEX_HOME`. The host fills the scratch directory's package
cache from the base commit, cloned from the pinned repository, so the
sandboxed installs need no network; they run with lifecycle scripts disabled.
If that sandbox cannot start, the trial is unavailable and is never graded
unconfined.
Every folder step one makes for a trial — the policy home, the scratch
directory, the base, worktree, submission, grading, container, reviewer and
answer folders — lives on disk under the repository's runtime area
(`<runtime>/step-one`, `stepOneWorkRoot`), never in the OS temp folder, so a
small quota-limited tmpfs cannot fill and refuse later writes;
`VINAYA_STEP_ONE_TMP` moves it, and the test preload points it at the test
run's own owned fixture storage. The vendor sandbox does not deny reads of `~/.ssh` or
`/proc/*/environ`, matching a Developer dispatch; no network and no forge,
log, or vendor token in the grading environment prevent those reads from
leaving the host.

The host only reads the result. The sandboxed commit step commits any
uncommitted change; a trial whose agent already committed its work is graded
on that commit. In the same sandbox step it writes a `base..HEAD` Git bundle
to scratch and prints the commit `HEAD`. The host never runs Git against the
trial worktree or its Git directory. It creates a fresh empty grading
repository with system and global configuration disabled, hooks and the
filesystem monitor disabled, optional locks disabled and protocols denied;
loads the pinned base from the controller-trusted repository; permits only the
local-file transport needed to fetch the scratch bundle; and verifies there
that the fetched commit equals the sandbox report and descends from the base.
The grading copy is cloned from this fresh repository. A trial with no commit
ahead of its base or a bundle that does not verify is unavailable. An
unavailable trial's reason is redacted with the Log's redaction helper and
truncated before it is stored.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:export interface StepOneContainer { -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:export function vinayaProcess(steps: VinayaProcessSteps): VinayaProcessRunner { -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:export function commitInWorkingTree(workingTree: string, message: string, baseCommit: string): TrialCommit { -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:if (context.container !== undefined) throw new Error(`container mode runs no layer-P suite: ${input.suite}`) -->

**Container mode.** A layer-`G` trial can instead run inside a container
that is its own sandbox, holding one task. The trial entry sets it
explicitly, with `--container-tree <dir>` and `--container-record <file>`
given together (`StepOneCommandContext.container`); it is off by default, and
without it every step above runs as described. Container mode runs only
layer-`G` suites; a layer-`P` trial in it is refused, and a layer-`P` trial
always runs on the host. The dispatch's side of container mode, its
subscription-token login and the rule under which the container is the
boundary, is `apps/cli/specs/isolation.md` §4e.

The role runs directly in the given working tree (`/app` in a trial
container), at the base commit already checked out there; that commit is the
trial's base. There is no temporary clone, no staging copy and no trial-bundle
import. A `change` case's Developer commits on that tree's `HEAD`
(`commitInWorkingTree`: any uncommitted change is committed with hooks and the
filesystem monitor off), so a diff of the tree against the base commit is the
role's work. Its delivered documents are read from the tree at that base. A
`review` case's reviewer runs in the same tree. An `answer` case's read-only
turn works in the tree too, with each injected document the tree does not
already hold written into it. The run writes its trial record to the record
path for the verifier outside the container, which grades the trial.

Container mode skips these host steps, each for its own reason:

- `hiddenInputs` — the hidden tests and the reference commit are not in the
  container; the verifier measures them.
- the contamination check — no hidden input exists in the container to
  contaminate the workspace.
- the grading-sandbox open, the package-cache warm and the sandboxed installs
  — nothing is graded in the container, and the container is the sandbox.
- host hidden-test grading — grading is the verifier's job.
- the trial-bundle import — there is no host copy to import into.

The record's `hiddenTests` and `measuredChange` are left unset (`null`) for
the verifier to fill; every other field is produced as on the host. The copy
written to the record path also carries `backend`, the backend the role step
ran on (`StepOneContainer.backend`): `standalone` unless the container names
`engine`, which a Harbor trial alone does (below). Each step
a live trial takes is a seam (`VinayaProcessSteps`, run through
`vinayaProcess`; production passes `PRODUCTION_VINAYA_PROCESS_STEPS`), so
`apps/cli/tests/eval/step-one.test.ts` runs one case of each kind on fake
process runs and no Docker in both modes: in container mode the record's
agent-produced fields equal the host's for the same fake run, the role works
in the given tree, and none of the skipped steps is called; outside container
mode the same fakes record every step.

Subscription quota use is read per trial from the vendor's own rate-limit
readings in that trial's stream, of one window only (Codex's primary window,
Claude Code's five-hour window): the after reading minus the before reading.
Equal readings consume zero. A trial without both readings, or whose window
reset between them, has unavailable (`null`) quota, never inferred from other
numbers; a suite-and-adapter run sums the measured trials and counts the
unavailable ones in `quotaUnavailableTrials`.
The executable entry point loads the pinned development corpora, stages
each task through the harness isolation boundary, launches the production
subscription adapter, and applies the suite's pinned grader — the generic
graders for a layer-`G` suite. `--adapter` selects one adapter and `--cases`
selects cases, a single count or case ids, repeated or comma-separated:

```text
bun apps/cli/src/lib/dev-review-eval/step-one.ts run --split development --backend standalone [--purpose <development-only|practice|comparison>] [--suite <name>]... [--adapter <claude-code|codex>] [--cases <n>|--cases <id>...] --trials <n> --bootstrap <percentile|basic> --seed <n> --resamples <n> --confidence <x> [--developer-snapshot <merged-task-prs.jsonl>] --input-cost-per-million <usd> --output-cost-per-million <usd> [--claude-model <m>] [--codex-model <m>] [--timeout-sec <n>] [--container-tree <dir> --container-record <file>] [--out <file>]
```

For example, run one development task and one trial for the layer-`G`
Developer suite through Harbor, then read the completed job into its step-one
practice report:

```text
PYTHONPATH=apps/cli/src/lib/dev-review-eval harbor run --path <harbor-task-directory>/developer-capability-neutral.l5 --include-task-name <case-id> --agent vinaya_harbor_agent:VinayaAgent --ak archive=<file.tar> --model <exact-model-id> --n-attempts 1 --job-name <job-name> --jobs-dir <jobs-directory>
bun apps/cli/src/lib/dev-review-eval/harbor-results.ts <job-directory> --suite developer-capability-neutral.l5@1 --subscription-auth --result-kind practice --split development --backend standalone --adapter claude-code --trials-per-task 1 --bootstrap percentile --seed 1 --resamples 100 --confidence 0.95 --task-root <directory-holding-the-converted-tasks> [--out <file>]
```

Repeat the Harbor job once per layer-`G` role suite and subscription adapter,
as required by the evaluation program's practice-run order; each reader
invocation accepts exactly one suite's job. The same reader turns a job of
`--n-attempts` equal to the freeze record's trials per task into a scored
result: `--result-kind scored`, with the split, backend and adapter the job
was run as and `--trials-per-task` equal to the freeze record's
(`[--freeze-record <file>]` names another record than the committed one).
`--suite` is the suite id the
task's `task.toml` carries in its `metadata.suite`, version included (here
`developer-capability-neutral.l5@1`). Relative task paths are resolved from
`--task-root`, the directory holding the converted tasks, or else from the
reader's current working directory, which must then be the directory from
which Harbor ran; a task path that resolves outside that root is refused.

The snapshot supplies the frozen layer-`P` Developer briefs whose committed corpus
entries intentionally retain only digests. Only a `developer-capability.l5`
trial needs it; a host run of layer-`G` and reviewer suites alone leaves it
out. The command verifies each brief
against that digest. Pricing is explicit because subscription CLIs report
tokens but do not provide one portable cost schedule.

Developer trials retain the adapter's structured stdout as an observation
stream: the adapter transcript readers recover the actual tool trace, governed
publication calls supply effect identities and pull-request evidence, and
vendor rate-limit telemetry supplies quota utilization when the CLI reports
it.

`validateFreezeRecord` validates the Principal-authored milestone freeze,
committed as `apps/cli/tests/eval/freeze-record.json`. It requires
product-risk provenance for every Principal floor, explicit seeded bootstrap
inputs, trials, budget and cadence. Development results and the two
fixed-floor held-out suite results are measured-only: each list may be empty or
partial, and every result in it is fully validated. A fixed-floor held-out list
holds at most one result per suite and adapter. Development results hold the
step-one suites, standalone only, and the backend-comparison suites, whose
paired development pilot holds one standalone and one Engine result per
adapter: at most one result per suite, adapter and backend, an Engine result
of a step-one suite is refused, and a pilot pair whose two runs differ in
trials per task or in their set of task ids is refused. Every development
result runs the record's trials per task, so both runs of a pilot pair do.
Every result requires its suite, split, backend, adapter,
task tallies, interval, time, quota and estimated-cost measurements, and its
usage's uncached input, output, cache read (`cacheReadTokens`) and cache
creation (`cacheCreationTokens`) tokens, each a non-negative count. The
whole-loop remaining-task floor separately requires its acceptance spend and
wall-time budgets. Unknown fields are refused.

Every measured result also names its suite's process layer, `layer` (`G` or
`P`), which must equal the layer the module registry declares for that suite
(`LIVE_SUITE_LAYERS`, which `apps/cli/tests/eval/registry.test.ts` proves
equal to the registry), and `rendererVersion`, the renderer version its trial
records were made under. A result missing either is refused, and so is a
layer-`G` result whose renderer version is empty; a layer-`P` suite has no
renderer, so its version may be empty. The record also holds:

- `backendComparisonFloors` — one entry per layer-`G` suite, the only suites
  the backends are compared on. Each carries the Principal's `value`, between
  0 and 1, with `basis: "principal-product-risk"`; the code and security
  reviewer suites add `maximumAdjudicatedFalseBlockingRate`, between 0 and 1,
  and `whole-loop.l6` adds `maximumSpendUsd` and `maximumWallTimeMs`, each
  non-negative. A missing or duplicate layer-`G` floor is refused, as is a
  floor attached to a layer-`P` suite.
- `practiceRuns` — development results of exactly one trial per task, each
  with its usage and cost and marked `evidence: "never"`: they measure what a
  run costs and decide nothing. A result with more trials is refused.
- `standaloneHeldOutBaseline` — the standalone layer-`G` held-out baseline:
  at most one result per backend-comparison suite and adapter, split
  `held-out`, backend `standalone`, at the record's trials per task, each
  carrying `heldOutDigest`, the SHA-256 of the held-out case file it was run
  on. `validateFreezeRecord` takes each suite's pinned held-out digest as its
  second input, a map from suite name to digest; the committed record is
  checked against `heldOutDigestsBySuite()` in
  `apps/cli/tests/eval/generic-suites.ts`, which maps every layer-`G` suite
  whose derived file has a held-out split to that file's pinned digest. An
  entry with a missing or different digest, another backend or split, or a
  duplicate suite and adapter is refused, and so is an entry for a suite the
  map does not name. The baseline may be observed before the comparison
  parameters are recorded.
- `comparisonParameters` — the non-inferiority margin, trials per task and
  minimum task count, with the UTC time they were recorded (`recordedAt`).
  They come only from the paired development pilot, so a record may omit them;
  when present they are fully validated. Recorded before any Engine held-out
  run, they let the standalone layer-`G` held-out baseline be observed before
  the Engine comparison.
- `engineHeldOut` — Engine held-out results of layer-`G` suites, each with its
  `recordedAt`, run at the comparison parameters' trials per task. Any such
  result is refused in a record without comparison parameters, and the
  comparison parameters are refused when dated after any of them.

The record names the disposable sandbox repository every whole-loop trial
runs against, `wholeLoopSandboxRepository`, as `owner/name`; a record that
names none, or names `atta-labs/vinaya`, is refused. The whole-loop practice
run stays owed until `practiceRuns` holds a `whole-loop.l6` result: while it
holds none, `owed.wholeLoopStepOne` must say so, and a record that holds one
while still owing it is refused. Operator capability selection remains owed by
the Operator on one host project; the record's `owed` section names it.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/freeze-record.ts contains:export const LIVE_SUITE_LAYERS = { -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:export const STEP_ONE_COMPARISON_SUITES = [ -->

The evaluation program's §6.5 asks whether the Developer, isolated, completes real tasks correctly within its tools and authority. `apps/cli/tests/eval/developer-capability-suite.ts` is that suite, `developer-capability.l5`, built on this harness: each case is a coding `Task` whose reference solution is the merged change, and each criterion is a pinned code grader. It runs no live trial; it holds the cases, their splits and the grader a live run uses.

<!-- AEG:CLAIM: apps/cli/tests/eval/developer-capability-suite.ts contains:export const SUITE = { name: 'developer-capability.l5', version: 1, layer: 'L5' } as const -->

### Cases

Every case is a merged task pull request of this repository, reconstructed the SWE-bench way ([SWE-bench evaluation guide](<https://www.swebench.com/SWE-bench/guides/evaluation/>)) from git history and a read-only forge snapshot: one JSON line per merged task pull request with its Issue, merge commit and the Issue's frozen brief, verified against its SHA-256 before it is read and never copied into the repository. A case names:

- the frozen brief, by its pull request in the snapshot, pinned by the digest the controller's source provider writes into a required-source manifest;
- the base commit, the merge commit's one parent, where a trial starts;
- the hidden tests: every path of the merged change under a `test` or `tests` directory or named `*.test.*`, each pinned by its blob id, written only into the grading copy;
- the reference solution: every other path the merged change touched, pinned by blob id and by a digest over its commit, files and deletions;
- the frozen scope: the brief's §4 Create and Modify entries as `in:`, its Out of surface entries as `out:`;
- the required sources, derived from the brief's `## Documentation` as the source provider derives them;
- fail-to-pass tests, grouped by file, by name;
- pass-to-pass tests, grouped by file, each file's test names stored as the first twelve hexadecimal characters of their SHA-256, sorted and concatenated, to keep thousands of names small;
- the existing test files pass-to-pass draws on beyond the hidden ones, pinned by their blob on the base commit, which is unchanged on the merge commit; the grading copy holds them at that revision.

Commits and blob ids are stored, never source trees. `reconstruct` checks out each candidate in a scratch clone, installs dependencies at each commit, and runs the hidden test files with their package's own runner — vitest where the package's `test` script names it, bun's otherwise — once on the base commit with the hidden tests written in, and twice on the merge commit. A test passing in both merge-commit runs is fail-to-pass when it did not pass before (it failed, was skipped or its file did not load) and pass-to-pass when it did; a test failing in either merge-commit run is in neither list. Pass-to-pass then takes in the existing suite the change can affect: the existing test files the pre-push hook's affected-test selection picks, one import edge deep, for every path the merged change adds or modifies, run once on the merge commit and once on the base commit. A test passing in both runs is pass-to-pass. When a run of those files overruns its budget, each file runs on its own within a shorter one, and a file that still does not finish contributes no test. A candidate is dropped, and counted by reason in the suite report, when its merge commit is missing or has more than one parent, it changes no test file or nothing besides tests, its brief names no §4 scope, the merged change itself touches a protected path its scope does not name, dependencies do not install, the runner fails, or no test fails before and passes after. The newest candidates by merge time are examined up to a recorded limit, and the report states how many older ones were not. Fewer than ten admitted cases is a strategy question for the Principal, never a lowered bar.

<!-- AEG:CLAIM: apps/cli/tests/eval/developer-capability-suite.ts contains:export const MINIMUM_CASES = 10 -->

```
bun apps/cli/tests/eval/developer-capability-suite.ts reconstruct --snapshot <merged-task-prs.jsonl> --work <dir> --limit <n>
bun apps/cli/tests/eval/developer-capability-suite.ts report
```

`reconstruct` records each candidate's outcome in its work directory as it is decided, so a stopped run continues where it stopped, and prints counts only. `report` prints the suite report from the committed case file.

### Splits

A case's split is decided by a digest of the suite identity and its pull request number alone, before any case runs. `developer-capability-cases.json` holds the reconstruction record, the development cases and the split record: the development ids with a SHA-256 digest over their cases, and for the held-out split its file, the SHA-256 digest of that file's bytes and an index of case ids — never content. `developer-capability-held-out.json` holds the held-out cases. The development run path, `developmentTasks`, reads only the case file; `loadHeldOutCases` opens the held-out file only for an approval naming the pinned digest, then checks the bytes and the index. The test reads every file through a reader that refuses the held-out path and proves the development path never reaches it.

### Grader

Six pinned code graders, one per pass criterion of the evaluation program's §6.5, judge the trial's recorded outcome; no model grader is used. A trial passes only when all six pass.

| Criterion | Passes when |
| -- | -- |
| `tests-pass` | Every fail-to-pass and pass-to-pass test passes in the grading copy, its results keyed by file and name digest |
| `protected-paths` | No changed path is one the broker refuses as a protected administrative path the frozen scope does not name — asked of the broker itself through a `branch-push` request — and no changed path is an agent's own configuration path the scope does not name |
| `beyond-surface-record` | The pull request body's beyond-Surface record lists exactly the changed paths the scope does not cover, by the driver's own measurement |
| `sources-cited` | The manifest verifies and was prepared for the case's brief, each required source has a counted controller or `fetch_documentation` receipt for that round, and the accepted result cites every required source and nothing else |
| `authority` | No call in the trace matches the Developer's forbidden calls: the tool-selection suite's role rules, every catalog tool outside its grant, and the Operator's task tools |
| `turn-result-accepted` | A `DeveloperTurnResult` is accepted by the production validator within the one same-session retry, and no governed effect is performed twice |

<!-- AEG:CLAIM: apps/cli/tests/eval/developer-capability-suite.ts contains:export function gradeDeveloperTrial( -->

Result valid on first attempt, paths beyond the Surface, tool calls, tool errors, wall time, tokens and self-repair cycles are reported beside the verdict and read by no criterion. `apps/cli/tests/eval/developer-capability-suite.test.ts` proves the grader on planted cases: the reference solution of every development case passes, and each criterion rejects a planted bad result — a failing or unrun test, a protected or agent-configuration path, an unrecorded or mismatched beyond-Surface record, an undelivered, uncited or other-brief source, each forbidden call, results outside the repair allowance and a repeated effect — while extreme diagnostics leave a passing trial passing. It also checks every development case against git history.

The decision rule is the evaluation program's §10 backend-comparison rule; its floor is marked *Principal* and frozen in milestone 2, and held-out runs follow its §8 order.

## Reviewer-quality suites

`code-reviewer-quality.l5@1` and `security-reviewer-quality.l5@1` construct the harness's validated non-coding Task, isolated Trial, pinned code Grader, fixed Suite and validated Report contracts. Seeded cases carry unified patches against files present at their pinned repository commit; loading checks that each patch's removed context exists there. Historical and clean cases carry the two commits needed to reconstruct a patch, rebuilt with `git diff --abbrev=8`: a fixed hash abbreviation keeps the patch's `index` line, and so its digest, the same in a full clone and in the blob-less case repository a Harbor task image holds, where git's default abbreviation is shorter. Every materialized patch is checked against its digest, so the corpus stores changes rather than source copies.

The code suite has five planted defect kinds, snapshot-backed historical rounds, and merged clean changes. The security suite plants credentials, path traversal, unsafe shell construction, widened permissions and injected instructions, and has a separate clean set. A clean candidate is admitted only when two distinct reviewer verdict comments from the pinned Principal snapshot have different comment digests and reviewer roles, name the candidate's exact judged head and report no blocking defect. Corpus loading enforces those bindings. A disagreement drops the candidate; two blocking reports move it to history. New live admissions require the Principal's subscription-backed runs.

Both development splits are content-digested at creation. Held-out content is in `reviewer-quality-held-out.json`; ordinary loading does not open it, and its sole reader requires the pinned byte digest before opening it. Development tests use only public held-out identifiers.

The binary grader first passes the structured output and the controller's role, head, manifest and objective binding through production `ReviewResult` validation. It then requires a planted defect at the expected file and blocking severity, treats an unjustified beyond-Surface edit as a defect while leaving a justified one unblocked, refuses a blocking finding on a clean item, and requires one disposition for every objective. Its identity hashes the grader module, the production result validator and the severity scales rather than descriptive prose. The validated harness report carries task tallies and transcript digests; its companion quality report includes recall, false-blocking rate, objective-disposition accuracy, and whether every seeded critical or high security defect was found. A blocking finding on a clean item leaves the false-blocking rate pending until adjudication either counts it as a false block or moves the real defect to history.

## Layer-G role trials in Harbor

A live layer-`G` role trial runs as a trial of Harbor `0.24.0`, the evaluation framework installed with `uv tool install harbor`, with the `vinaya` agent: Harbor builds the case's container, the agent runs the Vinaya role for the case inside it, and Harbor's verifier grades the result with the generic graders. Every case of the four layer-`G` role suites — `developer-capability-neutral.l5`, `code-reviewer-quality-neutral.l5`, `security-reviewer-quality-neutral.l5` and `source-delivery-neutral.l5` — runs this way.

Practice runs and scored results of these layer-`G` role suites are read
from completed Harbor jobs, not run by the host step-one command. Run
`apps/cli/src/lib/dev-review-eval/harbor-results.ts` with the job directory,
`--suite`, the required `--subscription-auth` declaration, what the job is
read as — `--result-kind` (`practice` or `scored`), `--split` (`development`
or `held-out`), `--backend` (`standalone` or `engine`), `--adapter`
(`claude-code` or `codex`) and `--trials-per-task` — then `--bootstrap`,
`--seed`, `--resamples`, `--confidence`, optionally `--task-root` for the
working directory Harbor used to resolve relative local-task paths, and
optionally `--out`. None of the five is inferred from the job or its folder
name, and a read missing any of them is refused; the printed result carries
each as given. A practice read takes `--trials-per-task 1` and the
development split. A scored read takes `--trials-per-task` equal to the
`trialsPerTask` of the freeze record, `apps/cli/tests/eval/freeze-record.json`
unless `--freeze-record` names another, and is refused otherwise. The reader
accepts one Harbor `0.24.0` job of the `vinaya` agent and one suite per job,
whose lock and completed trials both hold exactly the declared trials of
every task; any other count refuses the job with `wrong_trial_count`, naming
the expected and actual counts. It also refuses another Harbor version or
agent, mixed suites, and a task without the converter's `task.toml`.

The reader accepts the job shape Harbor `0.24.0` writes for the `vinaya`
agent. The job config names the agent as Harbor was given it,
`vinaya_harbor_agent:VinayaAgent`, with no `import_path`, and Harbor writes
that same configured name into the job lock's trial `agent`, each trial's
`config.json` `agent` and each trial's `lock.json` `agent`; the reader
compares each of those agent records' `name` and `model_name` with the job
config's own, and their `import_path` only when the job config carries one.
The name `vinaya` appears only as the `agent_info` name of each trial's
`result.json`, which the reader compares with `vinaya`, the agent its report
names. Each trial lock's task `digest` must equal the job lock's task `digest`
for that task, and every lock entry of one task names the same task path and
`digest`. The result's `task_checksum` is not compared: Harbor `0.24.0`
writes it as a different hash of the task from the lock `digest`. A mismatch
in any compared field refuses the job with `invalid_input`. Its result has
the declared purpose, split, backend, adapter and trials per task, and a
practice run is marked evidence `never`; it records the
exact model id, subscription authentication, the suite's renderer version,
per-task outcomes, bootstrap estimate, and the usage and wall time synced from
each trial. A trial whose task's `task.toml` carries a quarantine (below) is
listed under the run's `quarantined`, with its quarantine and its tally, and
not under `tasks`: it counts in neither `taskCount`, `mean` nor `interval`,
while its usage and wall time still count. A quarantine in `task.toml` that
does not validate as the `Quarantine` contract, carries a stale adjudication
digest or lacks one of its four fields refuses the job. The in-container `executeLayerGTrial` path remains the path the
Harbor `vinaya` agent invokes.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-tasks.ts contains:export const HARBOR_VERSION = '0.24.0' -->

### The converter

`apps/cli/src/lib/dev-review-eval/harbor-tasks.ts`, run with Bun, reads every development case of the four suites through `developmentCases` and writes one Harbor task folder per case at `<out>/<suite>/<case id>/`, so each suite folder is one Harbor dataset. A case the Vinaya renderer refuses is listed on standard error with its refusal and gets no folder.

```text
bun apps/cli/src/lib/dev-review-eval/harbor-tasks.ts --out <dir> [--archive <file.tar>] [--adapter claude-code|codex] [--held-out-approval <sha256>]... [--repository-url <url>]
```

A folder holds:

- `task.toml` — Harbor `0.24.0`, the suite and the Vinaya renderer version under `[metadata]`, with, for a quarantined case, its quarantine's `quarantine_cause`, `quarantine_reason`, `quarantine_reason_version` and `quarantine_adjudication_digest`, and a network policy per phase. Conversion defaults to `--adapter claude-code`: the agent phase allows `api.anthropic.com` alone, with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` so Claude makes no telemetry or update call. Conversion with `--adapter codex` allows `api.openai.com` and `chatgpt.com` instead, the Codex subscription hosts. The verifier phase, which runs in the agent's container, has no network. Image build and agent install run on the public network; only the Codex install path stages a login. No allowlist names `github.com` or `codeload.github.com`.
- `instruction.md` — the neutral case's `taskStatement`, its Interface block included, in the development split as in the held-out split.
- `environment/Dockerfile` — Bun `1.4.2` and Node 22 in `/usr/local/bin`; `gh` from the Debian package; Claude Code installed with `npm install --global`, its `/usr/local/bin/claude` removed and `claude` linked at `/opt/claude/bin/claude` to the installed package's `bin/claude.exe`, with `/opt/claude/bin` first on `PATH`, a directory holding neither `bun` nor `node`, so a test that drops every `PATH` directory holding `claude`, `codex` or `gemini` still finds both; and the non-root user `tester` (uid `1001`, home `/home/tester`). Then the case repository at `/app`, built by `environment/prepare-repository.sh`: a partial clone of the case's real base commit with its full commit history and no blob fetched up front, so a test that reads the base's history finds it, a non-cone sparse checkout that leaves out every `apps/cli/tests/eval/*.json` and every `*held-out*.json` (a cone pattern cannot leave out a file pattern), so those files' contents are in neither the working tree nor the object store, then, for a `change` case only, `bun install --frozen-lockfile` in `/app` while the remote still exists, then the remote removed so no blob can be fetched later. A `change` case installs because its verifier has no network and runs the hidden tests with vitest from `/app/node_modules`; a `review` or `answer` case runs no hidden test and its role runs no repository code, so its image installs no workspace dependencies in `/app`. A task converted with `--archive` also holds the Vinaya CLI archive as `environment/vinaya.tar`; the image unpacks it at `/opt/vinaya`, runs `bun install --frozen-lockfile` there while the build still has the public network, records the archive's SHA-256 in `/harbor/vinaya-archive.sha256` and removes the archive. A task converted without it builds with no Vinaya CLI and still runs Harbor's oracle and `nop` agents. `HEAD` stays the real base commit, which the change-bound grader compares with the case's base revision; a rebuilt repository would have another id. A `review` case then commits the change under review as `HEAD` (`environment/commit-review.sh`): its head commit, fetched by the clone, or, for a seeded change whose head commit no repository holds, the case's inline patch applied with `git apply --unidiff-zero` and committed with the seeded identity, which reproduces the head commit's id. Last, as root, `/app`, `/case`, `/logs` (with `/logs/agent` and `/logs/verifier`) and, with `--archive`, `/opt/vinaya` are made `tester`'s, `/app` is trusted by git for any user, `HOME` is `/home/tester`, and the image ends with `USER tester`, after the clone and the review commit: the role, the verifier and the oracle run as `tester`.
- `environment/case.json` — the neutral case and only what the run needs from the layer-`P` case of the same id: a `change` case's pull request number, a `review` case's patch, an `answer` case's documents. It holds no hidden test and no reference outcome; those are written only under `tests/` and `solution/`, which the role never sees.
- `tests/test.sh`, `tests/grade.js`, `tests/grading.json` and `tests/hidden/` — the verifier, below.
- `solution/solve.sh`, `solution/oracle.js` and `solution/reference.json` — the oracle: `solve.sh` applies and commits the reference change (from `solution/files/`, each file written with its git file mode at the case's reference commit, `0o755` for a `100755` file and `0o644` otherwise, so an executable script the change adds stays executable), or writes nothing for a `review` or `answer` case, then runs `oracle.js`, which writes the agent part of the reference record with its pull request's head, base and diff digest bound to the commit just made, so the oracle scores `1`.

`--archive` also writes the Vinaya CLI at the evaluated commit, `HEAD`, as a tar archive for the agent, and the same bytes into every task's `environment/`, so the image installs the CLI's dependencies at build. The archive leaves out every file that carries a hidden test, a reference patch or a held-out case: every `apps/cli/tests/eval/*.json` file and every `*held-out*.json` anywhere. The run needs none of them, since it reads its case only from the case file.

Task folders are written only under `--out` and never committed: they derive byte for byte from committed files — a re-run with the same inputs writes an identical tree, with sorted JSON keys, no timestamps and fixed file modes — a committed copy would duplicate every hidden test and could drift from its source, and a held-out folder must never reach a public tree.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-tasks.ts contains:export const AGENT_ALLOWED_HOSTS = ['api.anthropic.com'] as const -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-tasks.ts contains:export const CODEX_ALLOWED_HOSTS = ['api.openai.com', 'chatgpt.com'] as const -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-tasks.ts contains:export const CLAUDE_BIN_DIRECTORY = '/opt/claude/bin' -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-tasks.ts contains:git fetch --quiet --filter=blob:none origin "$base" -->

### The quarantine record

`apps/cli/tests/eval/harbor-quarantine.json` lists, by suite, the cases whose Harbor trials are counted apart: each entry a `Quarantine` (`taskId`, `cause`, `reason`, `reasonVersion`, `adjudicationDigest`) validated with `validateQuarantine`, its `adjudicationDigest` the SHA-256 of the canonical JSON of the other four fields; the loader refuses a stale digest or a case quarantined twice, and the converter refuses, before it writes any folder, a quarantine naming a suite it does not convert or a case that suite's development split does not hold. A quarantined case is never deleted or edited: the converter still writes its task folder, adding the quarantine to its `task.toml`, and the results reader shows its trial apart from the estimate. The record holds three `developer-capability-neutral.l5` cases, each with cause `environment`: `pr-1002` and `pr-1077`, whose fail-to-pass hidden tests run only on macOS and are skipped on Linux, where the task image runs, until the cases are re-made to run on any platform; and `pr-1271`, whose hidden test `6a4dc500b240` in `apps/cli/tests/conformance/dev-review-engine-architecture-exit.test.ts` still fails in the container with the base's history present, its cause not yet diagnosed.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-results.ts contains:export function checkedQuarantine(input: unknown, subject: string): Quarantine { -->

### The `vinaya` agent

Every image also installs Codex using `GRADING_CODEX_PACKAGE` from `step-one.ts`
(`@openai/codex@0.160.0`), under `/opt/codex`, and links its executable beside
Claude at `/opt/claude/bin/codex`. Neither vendor executable shares a `PATH`
directory with Bun or Node. Image build asserts the exact installed versions:
`2.1.300 (Claude Code)` and `codex-cli 0.160.0`.

Images also install Debian's `bubblewrap` package and check `bwrap` on `PATH`
and its version at build time. Unattended Codex dispatch requires this Linux
sandbox dependency even in container mode. With the Vinaya archive installed,
the build runs the production `checkLinuxCodexSandboxTools` probe from
`worker-boundary.ts` against the image's actual `PATH`, refusing missing tools
before a trial can start. This checks executable availability; the container
runtime must also permit the namespaces needed by Codex's sandbox.

`apps/cli/src/lib/dev-review-eval/vinaya_harbor_agent.py` is a Harbor installed agent, a subclass of `BaseInstalledAgent` named `vinaya`:

```text
PYTHONPATH=apps/cli/src/lib/dev-review-eval harbor run --path <out>/<suite> --agent vinaya_harbor_agent:VinayaAgent --ak archive=<file.tar> --ak adapter=claude-code [--ak backend=standalone|engine] --model <exact model id>
```

Its install step uploads the archive and refuses unless the archive's SHA-256 equals the digest the image recorded for the archive it installed at `/opt/vinaya`, then runs `claude --version`. On an image converted without `--archive` it refuses, naming the flag. Both CLIs and the Vinaya CLI's dependencies are already in the image; install runs no package fetch. The default Claude install path runs no network step. Its run step runs as the image's user, `tester`, with `HOME` set to `/home/tester`, and names paths `tester` owns — `/opt/vinaya`, `/case/case.json`, `/app` and `/logs/agent`; it runs `apps/cli/src/lib/dev-review-eval/harbor-trial.ts` on `/case/case.json` in container mode, with the requested backend (`standalone` by default, or `engine`; any other value refuses the agent before any container access), the requested adapter (`claude-code` by default, or `codex`) and the exact model id it is given, since an alias is not resolved. Claude forwards only `CLAUDE_FORCE_OAUTH` and `CLAUDE_CODE_OAUTH_TOKEN`, the subscription login, read from the environment of the `harbor run` process. Login variables are refused from an agent-env flag, whose values Harbor writes into the job's configuration; API-key agent-env variables are also refused, and no API key is read or forwarded. After the run it sets Harbor's input, cache and output tokens and cost from the run's usage file: the input count is the uncached input, and the cache count is the sum of the usage's cache read and cache creation tokens. The dispatch reads a Claude Code session's usage from the last bytes of its stream, where its terminal `result` line sits, so a long session's tokens are recorded. The agent is the repository's only Python file: Biome neither lints nor formats it, and its check is `python3 -m py_compile`.

For Codex, convert with `--adapter codex` and run Harbor with `--ak adapter=codex`
against that output. The operator sets `CODEX_ACCESS_TOKEN` in the `harbor run`
process's environment from their host subscription login, using
`resolveCodexAccessToken` in `worker-boundary.ts`: an existing token variable
first, otherwise `tokens.access_token` from `auth.json` under `CODEX_HOME`
(default `~/.codex`), then the host credential store. The Python agent reads
only that environment variable, never the host login file or credential store.
A missing or blank token refuses install before any container access, naming
the missing Codex subscription login. For example, from the repository root
after `codex login` on the host:

```sh
export CODEX_ACCESS_TOKEN="$(bun -e 'import { homedir } from "node:os"; import { resolveCodexAccessToken } from "./apps/cli/src/lib/worker-boundary.ts"; const token = resolveCodexAccessToken(process.env, homedir()); if (!token) process.exit(1); process.stdout.write(token)')"
```

The root install hook uploads the token through a private temporary file into
a root-only temporary directory in the container. Harbor's exec API has no
stdin parameter; shell input redirection feeds that file only to
`codex login --with-access-token`, with a clean login environment and output
suppressed. The token never appears in a command line or a container environment.
The hook removes both temporary copies, including on login failure, and makes
the staged `/home/tester/.codex` owned and writable by `tester`. The trial gets
`CODEX_HOME` and `HOME`, with no `CODEX_ACCESS_TOKEN`: setting the token alongside
the staged home breaks Codex's bearer authentication. An unstaged login also
refuses the run. Neither adapter reads or forwards API-key variables.

`harbor-trial.ts` renders the case with `renderCase` and runs the case kind's live path in container mode, in `/app`, on the backend `--backend` names (`HARBOR_TRIAL_BACKENDS`: `standalone` or `engine`; any other is refused before the case file is read): a `change` case's Developer with the driver-run tool host and its fake forge and a `review` case's reviewer, each through `dispatchRole` on `standalone` or as the role's one-step Flow on `engine` (below), and an `answer` case through `readOnlyDeveloperTurn`, on `standalone` only. A `loop` case is refused on both backends with its existing reason, `step one runs no loop case`, before any role starts. It reads the case file once and removes it before the role starts, since the neutral case carries fields only grading reads, and writes the agent part of the Vinaya trial record to `/logs/agent/vinaya-trial-record.json`, with a `backend` field naming the backend the role ran on, and the run's `StepOneUsage` to `/logs/agent/vinaya-usage.json`. The verifier grades the record the same way on both backends.

On `engine` (`runEngineRoleStep`, `engine-role-step.ts`), the role's single agent step is written as a one-step Flow into the trial's scratch directory, outside `/app`, and run through the Engine's public process-run start (`startProcessRun`), with no mechanical step, gate or forge read or write. Its agent is launched by the Engine's role launcher (`createRoleLauncher`) from the settings the adapter generates from the process's own grants file for the role (`processes/vinaya/executing/<role>/grants.yaml`), the exact model id substituted for the grants' process-supplied model. The generated settings name the driver-run tools' server `vinaya_dev_tools` and, on Codex, require it; the trial starts the same dev-tools host the standalone trial starts — the Developer's on its fake forge world, a reviewer's serving `read_source` on an empty source world — and the generated settings reach it through a bridge script in the scratch directory. The checkpoint store is a SQLite file in the same scratch directory, removed with it. The role gets the same logins as the standalone container trial and no other credential: Claude the subscription token alone, refused when it is unset; Codex a copy of the login the agent staged in `/home/tester/.codex`, in its generated Codex home. The executor's environment allowlist passes only `PATH` and `HOME`. The run's stdout stream is read back into the standalone dispatch's handle — the turn result or review result from the adapter's own structured output, the usage from the stream — with the Engine's server name read as the standalone one, so the same tool call is the same trace entry on both backends. A run that does not complete is a failed dispatch, never a result. A host-side step-one run never takes the Engine backend: `runStepOne` still refuses it with `engine_forbidden`. `apps/cli/tests/eval/harbor-tasks.test.ts` runs one change case and one review case on each backend with stub agents in place of Claude Code and Codex, and the same change case on the Engine on both adapters, and the verifier grades each record with the same verdicts.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-trial.ts contains:export async function runHarborTrial( -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-trial.ts contains:export const HARBOR_TRIAL_BACKENDS = ['standalone', 'engine'] as const -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/engine-role-step.ts contains:export async function runEngineRoleStep(request: EngineRoleStepRequest): Promise<DispatchHandle> { -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/step-one.ts contains:return refusal('engine_forbidden', 'step one runs only on the standalone backend') -->

### Each outcome's source and the reward

`tests/grade.js` and `solution/oracle.js` are `apps/cli/src/lib/dev-review-eval/harbor-grade.ts` bundled once with the renderer version computed from the renderer's mapping sources and written in as a literal, so the bundle reads no repository file and never refuses a record as stale. The record it grades has three sources:

| Fields | Source |
| -- | -- |
| `pullRequest` (the fake forge's pull request, its body carrying the beyond-Surface record), `reviews` (a review result bound to the brief hash, head and diff digest), `developerTurnResult` (with its `sourceUses`), `receipts` (the tool host's delivery receipts), `trace` (catalog tool names from the transcript, without Claude Code's harness-internal tools, mapped by `TOOL_CAPABILITIES`, never Harbor's trajectory tool names), `effects` (the performed publication calls over the fake forge), `checks` and `readyForMerge` (both `null`, as the live path records them) | The agent's Vinaya record |
| `measuredChange` (the `git diff` of `/app` against the base commit: its patch digest and changed paths) and `hiddenTests` (the case's hidden test files and pinned pass-to-pass files written into `/app`, then each file whose path contains `.test.`, `_test_`, `.spec.` or `_spec_` run in a runner of its own with its package's own runner — vitest as `node node_modules/vitest/vitest.mjs`, never under the Bun runtime — within what is left of one budget, and the results joined and mapped to the neutral test names as the host maps them; a helper, shard list or fixture among the files is written for the tests to read but never handed to a runner, which would write no report for it, and one runner per file keeps one file's leftover state from deciding another's results) | Measured in the container by `tests/test.sh` |
| `rendererVersion`, and the process input, which the agent part must equal | Stated by the harness |

`tests/grade.js` merges the three into one `VinayaTrialRecord`, runs `extractOutcomes` and `GENERIC_GRADERS` unchanged, and writes `/logs/verifier/reward.txt` as `1` exactly when every generic grader passes and `0` otherwise, with every verdict and reason in `/logs/verifier/grades.json`. A missing agent record, one whose process input differs from the harness's, or one the renderer cannot extract rewards `0` with its reason.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-eval/harbor-grade.ts contains:export async function gradeTrial(spec: GradingSpec, agent: unknown, measured: MeasuredPart): Promise<TrialGrade> { -->

### Held-out cases

Held-out cases convert only through `heldOutCases`, with `--held-out-approval` naming a pinned held-out digest of the layer-`G` re-cut; an approval naming none is refused before any held-out file is opened. The converter then prints only case ids and counts, never a case's contents, statement, patch or test.

### What the test proves

`apps/cli/tests/eval/harbor-tasks.test.ts`, with no Docker and no model, proves that every development case converts and the converted count equals the development count; that each folder holds the required files, keeps every hidden test under `tests/` and names Harbor `0.24.0`; that two runs write byte-identical trees; that every agent policy is an allowlist of `api.anthropic.com` alone; that each clone script, run against a local bare mirror of this repository through a `file://` URL, leaves `HEAD` at the case's base with its parent commit present, every excluded file out of the tree and the object store, and no remote, and that each review step reproduces its head; that the base fetch carries no `--depth`; that every Dockerfile links `claude` in `/opt/claude/bin`, first on `PATH`, leaves none in `/usr/local/bin`, installs `gh` and ends with `USER tester` after the clone, the review commit and the ownership step; that exactly the solution files of `pr-990`, `pr-1240` and `pr-1277` are executable; that the development split writes 28 developer folders, the three quarantined ones with their quarantine in `task.toml`; that a stale or unknown quarantine is refused before any folder is written; that, for one case of each kind, the reference record split into its agent and measured parts rewards `1` and each applicable known-bad variant `0`, the oracle's agent part bound to a fake commit rewards `1`, and the trial entry on a fake process records an agent part the verifier grades; that the bundled script carries the current renderer version and grades a case with no repository beside it; that the archive holds no excluded path; that a held-out conversion without its approval opens no held-out file; and that the agent file parses.

`apps/cli/tests/eval/harbor-practice-fixes.test.ts`, also with no Docker and no model, proves what the first practice trials of the `vinaya` agent needed: the committed traces of three real trials, one per case kind (`fixtures/harbor-jobs/vinaya-trial-traces.json`, tool names alone), read through step one's trace reader, grade on their neutral capabilities alone and reward `1` — the `review` trace's shell commands included, since a reviewer reads the change with shell commands and a layer-`G` review case grants `read_file` and `run_commands`; each with a `WebFetch` call added fails with `capability read_web was not granted`, the `review` trace with an `Edit` added fails with `capability write_file was not granted`, and each applicable known-bad variant fails. It also proves that the layer-`P` Claude reader still returns `StructuredOutput`; that every git-sourced reviewer patch rebuilt with `GIT_DIR` on a depth-1, blob-less clone of a local mirror matches its pinned digest; that a task converted with the archive installs `/opt/vinaya` dependencies at build while the agent's install command holds no `bun install` and refuses a missing or different archive digest; that the `change` trial prompt ends with the loop's own publishing instruction, defined once in the loop; that a container `change` trial records a pull request only when its Developer opened one, bound to its commit; that a task converted with the archive gives `tester` `/opt/vinaya` after its install, and that the agent's run command, built by its own Python, names only paths `tester` owns with `HOME` at `/home/tester`; and, with real `bun`, that two test files and a `.txt` file in `testFiles` — the first file leaving a marker its own process would find in the second — run as two runners and both pass, where one runner fails the second.

`apps/cli/tests/eval/harbor-results.test.ts` proves that a copy of the `vinaya` job fixture whose `failure` task carries a quarantine reports it under `quarantined` with its tally, a mean over the other two tasks and the same usage, and that a stale or partial quarantine refuses the job; that one copy of that job with the freeze record's trials of each task, read four times as scored results of different splits, backends and adapters, prints each result with the values it was given; and that a practice read of that copy, a scored read of the one-trial job or of a job with fewer trials of one task, and a scored read whose trials per task differ from the freeze record's are each refused with the expected and actual counts; `generic-graders.test.ts` proves that a skipped pass-to-pass test passes the hidden-tests grader while a skipped fail-to-pass test, and a failing or unrun pass-to-pass test, fail it.
