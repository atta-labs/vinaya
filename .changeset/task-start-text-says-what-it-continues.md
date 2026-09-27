---
'@attalabs/aeg-core': patch
---

The `task_start` catalog text now states what the tool does. It opened "Distinct from `task_resume`: this tool starts a run, it does not continue a paused one" — false since the start handler began continuing a run that stopped with no decision pending: an exited run, a pause a ruling already resolved to resume, or a pause still inside the loop's own retry bound. That text is the only documentation an Operator is served for the tool, so denying the continue cases pointed it at `task_resume` for runs `task_resume` launches nothing for, which is how a stopped run was left with no working action at all. The text now says which runs this tool continues, and names the tool that owns the two it does not: `task_resume` for a pause still awaiting a decision, `task_cancel` for one already resolved as cancel. A test in the catalog's own suite pins both halves, so a future reword cannot quietly drop them.
