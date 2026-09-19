---
"@attalabs/aeg-forge-state": patch
"@attalabs/aeg-core": patch
---

A `Depends-on`/`Conflicts-with` edge written with a `#` prefix is a forge Issue number and is never ambiguous, whatever tranches its Milestone holds — only a bare, hash-less task number on a multi-tranche Milestone still refuses.

The cross-task Surface-overlap check now exempts two open task Issues sharing a Milestone when either depends on the other, directly or through a chain of `Depends-on` edges within that same Milestone cohort — such tasks can never run at the same time, so an overlapping Surface between them is no longer a false positive.
