---
"@attalabs/vinaya": patch
---

Name the failing check on the run's Summary page of the generated Vinaya Checks workflow.

The workflow's one aggregate check reports only "vinaya check --all --diff-only: failing" — it never says which of the registered checks failed, forcing a trip into the raw log. The generated job now tees the runner's per-check stdout (the `✓/·/✗ name: status` lines plus each finding's message) into a file, and a follow-up step appends it, fenced, to `$GITHUB_STEP_SUMMARY`.

Two guards are load-bearing: `set -o pipefail` before the tee, because the job's default shell is `bash -e` without pipefail and an unguarded pipe would report a red suite green; and the summary step runs on `!cancelled()` rather than `always()`, because the concurrency group cancels superseded runs routinely and their half-captured output is noise. Both the published (`npx`) and vendored (`node <bin>`) shapes get the same capture.
