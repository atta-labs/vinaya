---
"@attalabs/vinaya": patch
---

`task_start` and `task_resume` now report a start only once the launched run is confirmed alive — waiting, bounded, on the task's own driver lock — rather than reporting `started: true`/`outcome: 'started'` the instant a detached process is spawned. A run that exits before its driver lock appears is reported as a failed start carrying that run's own captured stderr, and the request claim it wrote is released so an identical retry launches again.

`task_start` now launches with an explicit `--agent`, resolved from the repository's configured `dispatch.agent` (`vinaya.config.json`) — the same fallback `vinaya task run` itself already reads. With no agent configured, the call refuses before claiming anything, naming the missing setting, instead of launching a run that would exit on its own missing `--agent`.

A request claim (`task_start`) or resume claim (`task_resume`) whose run is no longer alive — old enough that its own launch must have already concluded, and naming a task with no live driver — is superseded rather than replayed forever: the next identical call reports the dead run and launches again.
