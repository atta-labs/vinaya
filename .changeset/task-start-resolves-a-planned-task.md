---
"@attalabs/vinaya": patch
---

`task_start` now starts a planned task whose brief has not been frozen yet. It resolves the task's forge Issue over the open tranche-labeled Issues — an open Issue labeled `vinaya/tranche:<slug>` whose title's ordinal matches — the same resolution `vinaya task run <tranche> <n>`'s own preparation performs, reusing the identical title/label parser. Before, it resolved through the frozen-brief-filtered read `task_status`/`task_escalation_read` use, so it refused an open, dispatch-ready task with "has no resolvable Issue to confirm a launch against — refusing to start blind" until its brief had already been frozen by hand — a task `task run`'s own preparation freezes, which `task_start` is the thing that launches.

An ordinal that names no open task Issue is still refused before any launch, naming the tranche and ordinal it looked for. The stale-claim supersede path resolves through the same reader, and still treats an unresolvable Issue as alive so a transient forge read never relaunches a live run. `task_status` and `task_escalation_read` are unchanged — they still list and resolve only tasks with a frozen brief or a run.
