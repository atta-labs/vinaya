---
"@attalabs/vinaya": patch
"@attalabs/aeg-forge-state": patch
---

`vinaya archive tranche <slug>` now closes the tranche's Milestone only when every tranche the Milestone's own `### Tranche intents` section declares is `complete` — each one's lifecycle derived from its `vinaya/tranche:<slug>`-labeled Issues, the same derivation `vinaya milestone status` prints. A declared tranche with no Issues yet is `planned` and holds the Milestone open. Before, the decision read attached Issue states alone, so the first tranche of a product to finish closed the whole product's Milestone while most of its declared tranches had not been cut into Issues at all.

The retrospective is recorded either way, and the message and the confirm prompt name every unfinished tranche and its lifecycle. A Milestone whose description carries no `### Tranche intents` section keeps the older rule untouched: it closes once no attached Issue is open. A section present but carrying no line the intents parser can read holds the Milestone open — an unreadable declaration is still a declaration.

`@attalabs/aeg-forge-state` gains `hasTrancheIntentsSection`, the read that tells a Milestone declaring nothing apart from one whose declarations could not be parsed.
