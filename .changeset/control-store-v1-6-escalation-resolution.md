---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Persisted human decisions resume or cancel only their intended run. Adds `escalation` and `resolution` record kinds to the control store: an escalation record carries a pause's run identity, input versions, reason, evidence, attempted recovery and recipient without requiring chat history; a resolution is claimed exclusively per escalation (`consumeResolutionOnce`), so a second attempt — replayed, stale, or targeting the wrong PR — is refused rather than silently repeating. `listStartedEffectKeys`/`markEffectUncertain` advance an unconfirmed in-flight effect to `uncertain` under a fencing epoch. `vinaya dev-review-loop --resume <pr>` now consumes a resolution before continuing; a new `vinaya dev-review-loop --cancel <pr>` durably and idempotently cancels a paused run, terminates any in-flight worker through its own identity, and fences late results.
