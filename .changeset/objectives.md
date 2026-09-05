---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

A task Issue now carries a `## Objectives` section — numbered `O<n>. <sentence>` lines, one observable outcome each. `objectivesOf`/`objectivesVersion`/`renderObjectives` (`@attalabs/aeg-core`'s new `objectives.ts`) are the one parser and version hash every later consumer reads.

`vinaya issue create`/`vinaya issue edit` refuse a task Issue without one (`checkIssueObjectives`, wired through the new `objectives` `briefSchema` builtin), and `vinaya check coherence`'s R1 grades the same rule against the live stock — both for Issues numbered `OBJECTIVES_SINCE_ISSUE` (404) and above, so the pre-gate stock stays green.

On the brief side, `verify-brief`/`vinaya check brief-shape` now refuse a brief whose `## Objectives` section doesn't match its Closes-linked Issue's (`checkObjectivesCopy`), or whose numbered Parts don't cite every objective and vice versa (`checkObjectivesCoverage`). `vinaya brief render` copies the Issue's Objectives section into the rendered brief between the header and §2.
