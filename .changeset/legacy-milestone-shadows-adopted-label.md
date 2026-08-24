---
"@attalabs/aeg-forge-state": patch
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
"@attalabs/aeg-types": patch
"@attalabs/vinaya-sources": patch
---

A tranche adopted into a real Milestone (`vinaya milestone adopt`) could permanently read as `complete`
system-wide, even with real open Issues, because the retired one-tranche Milestone `adopt` closes
(never deletes, by design — its provenance survives) still title-matches the legacy 1:1 exception every
tranche reader checks first. `matchesLegacyMilestone`'s "kept forever, no exception" rule was written
for a Milestone that never changes underneath a slug — true for every pre-migration Milestone, false
the moment `adopt` exists.

Found live: `vinaya-agentic-interface-v1`'s legacy Milestone (`#7`) sat closed with zero native issues
after adoption; its real Issues (two open) live under the new consolidated "Flows become files"
Milestone via the `vinaya/tranche:vinaya-agentic-interface-v1` label. `findMilestoneForSlug`,
`listActiveTrancheSlugs`, `listArchivedTrancheSlugs`, and `indexTrancheMilestonesAsync` all reported it
`complete` — which made `verify-coherence.topology-move.test.ts`'s live-forge assertion (some tranche
resolves active) fail repo-wide, since every adopted tranche in the repo hit the same shadow. That test
gates `verify-task`, which `open-pr.ts` runs unconditionally — so no task-branch PR could open in this
repo until this fixed.

`resolveLegacyFacts` now checks the slug's `vinaya/tranche:<slug>`-labeled Issues before trusting a
closed legacy Milestone's `state`: a non-empty label population is this tranche's real, current
identity and wins over the (possibly stale) Milestone read. An empty label population — a genuinely
historical, pre-label-model tranche, or a legacy Milestone nobody has adopted away from — still resolves
from the Milestone's own `state`, exactly as before. All four readers now fetch that slug's Issues
regardless of legacy status, which the async index runs concurrently with everything else it already
fetches.
