---
"@attalabs/aeg-forge-state": minor
"@attalabs/vinaya-sources": minor
"@attalabs/vinaya": minor
---

Adds `vinaya milestone status <n>` — read-only, prints each of a Milestone's declared `### Tranche intents` slugs with its forge-derived lifecycle (`planned`/`active`/`complete`) and its labeled Issues' counts (merged, open, not planned). `@attalabs/aeg-forge-state` gains `intentLines`, the enumeration sibling of `intentGoalForSlug`, and an optional `stateReason` field on `GhIssue`/`gh issue list`'s requested JSON fields.
