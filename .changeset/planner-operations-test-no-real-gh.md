---
'@attalabs/vinaya': patch
---

The planner operations test reads a missing task's brief through a fake assembler, so it no longer reaches the real GitHub CLI. Before, one case ran the real brief assembler, which read the repository's milestones with `gh api`; the default branch's test scheduler counted that call and failed the group.
