---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

`vinaya task status --follow` shows a task's log with its detail lines and hides them with `--quiet`; `vinaya task run --quiet` hides them on the live terminal. The log file always keeps the detail lines. The command reference lists both flags, and the missing `--follow` row on the status command.
