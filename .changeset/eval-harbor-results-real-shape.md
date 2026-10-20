---
'@attalabs/vinaya': patch
---

The Harbor results reader accepts the job files Harbor 0.24.0 really writes for the `vinaya` agent: it compares each config and lock agent with the job config's configured agent name, keeps `vinaya` for the trial result's `agent_info` name and the report, and binds each trial lock's task digest to the job lock's instead of comparing the result's `task_checksum`, a different hash.
