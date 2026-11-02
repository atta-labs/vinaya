---
'@attalabs/vinaya': patch
---

On the Engine runner, every role's dev-tools calls (`publish_changes` among them) may now run as long as the ready push: the per-call limit is the larger of 1800 seconds and `reviewPolicy.readyPushTimeoutMinutes`, read once when the runner starts, for Claude Code and Codex alike. A policy that cannot be read keeps 1800 seconds.
