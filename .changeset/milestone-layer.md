---
"@attalabs/vinaya": minor
"@attalabs/aeg-core": minor
"@attalabs/aeg-forge-state": minor
"@attalabs/aeg-types": minor
"@attalabs/vinaya-sources": minor
---

A Milestone now means a product goal, not a tranche. Previously a GitHub Milestone and a tranche were
1:1, matched by title — a Milestone could hold exactly one tranche and nothing wider. It now holds
many:

- `vinaya milestone create` — makes a real product-goal Milestone, with an optional `Release:` target
  version, gated by `checkMilestoneShape` before any forge write.
- A tranche's lifecycle (`planned`/`active`/`complete`) derives from its `vinaya/tranche:<slug>` label
  and Issue set, not from a Milestone title — `fetchMilestone` no longer requires a Milestone to exist
  at all for a tranche to resolve. A Milestone titled exactly a known tranche slug still resolves the
  old way, so nothing existing needs migrating.
- The **Architect** role — a goal in, an ordered list of tranche intents out. Invoked manually; it
  never cuts task Issues itself, that stays the Planner's job one altitude down.
- `vinaya milestone adopt` — moves an existing tranche's Issues into a real Milestone and closes (never
  deletes) the retired one-tranche Milestone, refusing atomically before any write on an unknown slug,
  an empty tranche, a closed/missing target, or a slug already adopted elsewhere.

No `managed.*` config key was added for this — creating a milestone is one `vinaya milestone create`
call per milestone, run by hand, not a desired-state declaration for an installer to converge on.
