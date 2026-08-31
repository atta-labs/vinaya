---
"@attalabs/vinaya": patch
---

`roles/architect.md` no longer denies `vinaya milestone edit`, which has shipped since PR `#235`. The correction separates two questions the doc was conflating: the CLI fact (`edit` exists, gated by the identical `checkMilestoneShape` check `create` uses) from the still-live governance question (who may invoke it). The Architect's create-once boundary is kept and now argued rather than asserted from a false premise; ownership of `edit` is assigned to the Principal (`roles/principal.md` "What the Principal owns"), since correcting an already-declared Milestone's goal or `Release:` field is the same product call `milestone-model.md` §5 already names for the original declaration. `milestone-model.md` §3 and `roles/principal.md` each carry the ownership sentence.
