---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

`task_start` accepts a standalone Issue number as well as a tranche and a task number. Its input is now the same `TaskToolRef` union every other task tool already takes, so a standalone task Issue an Operator can already watch, resume and cancel is one it can also start — previously the only way to start one was to move it into a tranche by hand. Whichever form is used, the launched command is the one the CLI itself exposes for that form (`task run <tranche> <n>` or `task run --issue <n>`), through the same launcher, the same `VINAYA_TASK_RUN_COMMAND` override and the same driver-lock liveness confirmation.

A task keeps exactly one address: a `{ issue }` start is refused (`precondition`) when the number is no Issue, is closed, or carries a `vinaya/tranche:*` label — the last naming the tranche and the form to use instead, because a second address would split the task's claims. The address form is part of the request identity, so `{ issue: 729 }` and a tranche ordinal resolving to Issue 729 never collapse into one claim; a tranche identity is computed from the same bytes as before, so a claim written by an earlier version is still found and an in-flight run is never started twice by an upgrade. The MCP input schema the server advertises widens with the tool.
