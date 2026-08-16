---
"@atta/aeg-core": patch
---

Fix the generated review gate so a pull request holding clean verdicts reports green without human intervention.

Two defects, both in workflows `vinaya init` writes into every adopter's repository:

- **Duplicate runs.** `vinaya pr create` opens the pull request and applies its tranche label immediately after, so `opened` and `labeled` arrive together and GitHub starts two runs of the same workflow. Both report under one check name and the merge box counts both, so one could go green while its twin held a stale red. The two `pull_request`-triggered workflows now carry a concurrency group keyed per pull request.

- **The verdict retrigger selected the wrong run.** It re-ran every completed run, which put several into one concurrency group at once and had `cancel-in-progress` kill all but the last — cancelled runs report red. Selecting the newest was also wrong: `--status completed` excludes a run that is re-running but includes cancelled ones, so a verdict arriving mid-flight could rerun a stale cancelled sibling and cancel the live evaluation. Selection is now by head SHA, excluding cancelled runs — the run for the current head is the only one whose conclusion gates the merge.

Unchanged: the gate still fails when no verdict exists. "Nobody has reviewed this" must block a merge.
