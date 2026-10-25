---
'@attalabs/vinaya': patch
---

On the Engine runner, a step that refuses and pauses the run — `prepare-run` on any refusal, including inactive enforcement controls and a task not ready to dispatch, `prepare-sources`, and `check-premise` — is no longer recorded as completed, so the run resumed after the cause is fixed runs it again and creates the task worktree before any later step reads it. A task worktree that does not exist now pauses as an infrastructure stop naming its path, not as a missing required source.
