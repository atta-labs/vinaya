# @atta/aeg-core

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
