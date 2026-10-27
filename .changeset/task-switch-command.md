---
'@attalabs/vinaya': minor
'@attalabs/vinaya-sources': minor
---

`vinaya task switch` changes the agent or model a task continues on: it refuses while the task's driver is alive, moves the Engine checkpoint aside into a timestamped folder without deleting it, leaves the branch and pull request untouched, and writes one driver-log line naming the from and to agent and model. The Engine's refusal of another agent now names this command.
