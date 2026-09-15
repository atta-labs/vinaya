---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

`vinaya task run <tranche> <n> --agent <vendor> --background` (and the `--issue <n>` form) starts the controller as a detached second process and returns a durable run handle only once the control store has recorded an acquired ownership epoch and the child's own identity under it. The controller survives the calling terminal or conversation exiting, runs in its own process group, and has its output routed into the same per-task loop log `task status --follow` already tails. `task status` itself now falls back to this same record to report a background controller by pid before its own driver lock lands. A repeated `--background` call against a still-live controller reattaches to the same run instead of starting another; a restart after a crash fences that controller's unconfirmed effect writes before acquiring a fresh epoch; a host that cannot supervise a detached process (no POSIX process groups) refuses before anything is launched. The control store's `run` record gains an optional `childStartedAt`/`childCommand` identity pair for this.
