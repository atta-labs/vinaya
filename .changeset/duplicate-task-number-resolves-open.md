---
'@attalabs/vinaya': patch
'@attalabs/aeg-forge-state': patch
---

A tranche that holds a closed not-planned Issue and an open Issue under one task number now resolves that task to the open Issue in the dispatch-readiness check, and two open Issues under one number refuse naming both. The batched forge query names each Issue's sub-query by Issue number so two tasks can no longer collide on one alias, and a failed forge query now refuses with its own reason instead of surfacing as a phantom Issue reference.
