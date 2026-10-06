---
'@attalabs/vinaya': patch
---

The background task run and the Operator's start and resume tools now start their driver through one shared detached-launch helper, and a plain `vinaya task run` from an interactive terminal prints, before the loop starts, that it stops when the terminal closes and the exact `--background` command to use instead. A driver that is stopped now also ends the processes its own tools started — a push running the pre-push hook and its tests, a check run, an evidence refresh — instead of leaving them running.
