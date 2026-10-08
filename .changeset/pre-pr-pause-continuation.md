---
'@attalabs/vinaya': patch
---

A task that paused before its pull request existed can always continue. Once the pull request is open, `vinaya task run`, `dev-review-loop --resume <pr>` and `--cancel <pr>` bind the pause to it, accepting only the open pull request on the task's own branch, and continue from it. A GitHub rate limit or other infrastructure pause recorded before the pull request existed is now watched by the paused driver, which resumes it by itself under the same limits as any other automatic resume. A refusal from these commands, or from the Operator's `task_resume` and `task_cancel`, now names a next step that works, including when the escalation record is missing.

The loop no longer treats a fork's pull request from a head ref of the same name as the task's own, whether attaching to it or binding a pause to it.
