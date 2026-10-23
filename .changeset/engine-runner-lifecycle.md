---
'@attalabs/vinaya': minor
---

The Engine runner owns its run lifecycle. It takes the task's driver lock (a second runner for the same task exits and names the holder), resumes a task's checkpoint on a re-run, attaches to an already-open pull request without dispatching a Developer, launches each role under its dispatch ceiling, emits the five-minute driver heartbeat, records the driver exit exactly once, and ends every agent process group when the run stops or SIGINT or SIGTERM arrives. The heartbeat, the exit record, the driver lock's keep-or-clear rule and the journal seeding are now shared by the standalone loop and the Engine runner.
