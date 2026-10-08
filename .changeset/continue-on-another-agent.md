---
'@attalabs/vinaya': minor
---

A task that already has a pull request can now continue on another agent. Resuming it with an explicit `--agent` that differs from the one that ran it (through `vinaya task run` or `dev-review-loop --resume`) starts a fresh session of that agent on the same branch and worktree, instead of refusing. The pull request's `**For:**` line now names every model that worked on it with the rounds each ran, and the held pause record and the printed resume command name the agent that ran last.
