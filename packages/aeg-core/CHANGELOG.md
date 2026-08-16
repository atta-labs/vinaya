# @atta/aeg-core

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
