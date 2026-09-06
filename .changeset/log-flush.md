---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

Adds the `forge_write` family to the Vinaya Log schema (`ForgeOpSchema`, `ForgeWriteEventSchema`, `LogEventSchema` widened to a three-way union) and `vinaya log flush --issue <n> | --pr <n>`, which posts a target's outbox as one or more marked comments (`<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->`), logs its own `forge_write` line before truncating, and truncates only the lines the forge confirmed.
