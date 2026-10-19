---
'@attalabs/vinaya': patch
'@attalabs/aeg-forge-state': patch
---

`vinaya check coherence` on a task branch now runs the blocking rules A2 and L5 for the branch's own tranche: a closed task whose closing pull request merged on or after the enforcement cutoff without a provenance block fails it, and so does an active tranche whose task Issues are all closed. A lost provenance read or a missing token fails it as `severity:infra`, never as a pass. L5 also sweeps every other open legacy-titled tranche and prints its findings, and any tranche it could not read, as warnings that leave the exit code alone. The per-slug Milestone index now returns a `SlugMilestoneIndex` naming those other open legacy tranches, from the Milestone list it already reads.
