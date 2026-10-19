---
'@attalabs/vinaya': minor
'@attalabs/aeg-core': minor
---

`vinaya task run` assigns the task's Issue to the identity `gh` is authenticated as when the run starts and the Issue has no assignee — in the foreground, with `--background`, or through the Operator's `task_start` tool. A failed read or write prints one warning and the run continues. The `issue-assignment` check, which wrote that assignment to the forge from `vinaya check`, is removed, along with the standalone first-push assignment script. `decideIssueAssignment` now takes only the Issue, its current assignees and the authenticated identity.
