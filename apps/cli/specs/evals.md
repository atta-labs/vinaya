# Evaluation harness — contracts and estimators

Status: draft

The evaluation program (`apps/cli/specs/dev-review-evaluation-program.md`) defines four harness ports — Task, Trial, Grader, Report — and the statistics reported over them (its §3, §7, §8, §9 and §11). This file describes the code that implements those contracts and estimators, `apps/cli/src/lib/dev-review-eval/contracts.ts` and `apps/cli/src/lib/dev-review-eval/estimators.ts`, and the module registry the program's §6 requires, `apps/cli/src/lib/dev-review-eval/registry.ts`. Vocabulary is the evaluation program's §3, used exactly.

Nothing here stages a trial, isolates a repository, runs an agent or decides acceptance. Those come later; this layer gives them typed values to exchange and pure functions to compute what a report shows.

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
- **A component row** names its `kind` (port, node, role, tool, gate, transition, effect, adapter, isolation boundary or product guarantee), an id `<kind>:<name>`, exactly one catalog module, and the ten fields, every one stored on the row. Copying a module's value is allowed; leaving a field to be inherited is not. Its `suite` field names only suites its module declares, as `<name>@<version>`.
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

`apps/cli/tests/eval/registry.test.ts` checks the catalog against the mirror — one entry per `### 6.n` heading, the ten fields of its table in order, one suite per listed layer, the mirror's revision — and every refusal above; the typed-sources test prints the per-kind counts and fails on any missing, extra or invalid row.
