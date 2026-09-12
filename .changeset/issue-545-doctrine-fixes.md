---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
"@attalabs/aeg-forge-state": patch
---

Five doctrine defects fixed: the pre-push selector always runs test files named under a new `prePush.alwaysRun` config key plus every test file added or renamed in the diff; `rings.ring1_forgeWriteInterception`/`ring2_asyncAudits` now mean what they say (`true` runs the ring, `false` opts out — inverted from before, with a version-gated `vinaya upgrade` migration for a stale config); `requireTrancheQualifiedEdges` refuses a bare `Depends-on`/`Conflicts-with` edge id once its Issue's Milestone holds two or more tranches; the post-merge Archivist self-chains into `archive tranche`, which now appends a `### Retrospective: <slug>` section (task count, rounds per task, merged PRs) to the Milestone description once a tranche is complete; the evidence runner's per-command budget is now `report.commandTimeoutMs` (default 15 minutes) instead of a hardcoded 30 seconds; and a closed Issue's status rules now run before `branch-exists`, so a closed NOT_PLANNED Issue with a lingering task branch reads `dropped`, never `in-flight`.
