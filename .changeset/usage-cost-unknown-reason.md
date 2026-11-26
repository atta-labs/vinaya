---
"@attalabs/vinaya-log-sdk": minor
---

A usage record keeps its tokens and says why its cost is unknown: `log.usage.recorded` takes `costUnknownReason`, a short code written as `vinaya.usage.cost_unknown_reason` beside every token figure given. A cost wins over the reason, and the existing `unknownReason` still means no figure is known and drops them all. `vinaya-log usage recorded` takes the field, and the usage line reads the tokens with the reason, or the cost and whether it is exact or estimated.
