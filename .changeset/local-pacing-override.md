---
'@attalabs/vinaya': minor
'@attalabs/vinaya-sources': minor
---

A gitignored `vinaya.config.local.json` at the primary checkout's root overrides `reviewPolicy.maxRounds` and `reviewPolicy.maxTaskMinutes` for local runs. Every other key in it is ignored with one warning, and a role process, a CI job, a task worktree or a symlinked file never honours it. The review thresholds and the merge gate stay on the default branch's policy, and `vinaya doctor` reports when an override is in effect.
