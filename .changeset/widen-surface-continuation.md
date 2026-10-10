---
'@attalabs/vinaya': minor
'@attalabs/vinaya-sources': minor
---

`vinaya task run <tranche> <n> --widen-surface <glob,...> --reason <text>` (and the `--issue <n>` form) continues a pre-pull-request escalation whose Developer asked for `widen_surface`: it supersedes the frozen brief with the widened Surface, records that as the escalation's resolution, grades the widened Issue through the write gate, then starts the run. It refuses before any of that when the pause is not such an escalation, a driver is still alive, the escalation was already answered, or the widened body fails the gate. The escalation packet names the command with the globs the Developer asked for, and `task_resume` refuses such an escalation naming it.
