---
'@attalabs/vinaya': patch
---

A task whose required documentation source cannot be read never starts a Developer turn. The readiness gate now fetches every source the task lists before each turn and refuses to start when one cannot be read, naming the source and the failure; a timeout is retryable, while a login page, an error status or another host needs the Planner to correct the task.
