---
'@attalabs/vinaya': patch
---

A head whose CI workflow run failed now reads red in the review loop and in the Operator's pull request read, even when every job that exists passed. Previously only the check-runs were read, so a run that GitHub failed after creating only some of its jobs (its test jobs never created) read green and could merge untested. The newest run of each workflow decides, so a successful re-run clears an earlier failure; runs still in progress read pending; and the failure the Developer is handed names the workflow, run id and conclusion.
