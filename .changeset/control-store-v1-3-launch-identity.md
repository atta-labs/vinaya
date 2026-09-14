---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Role launches and sessions gain durable identities and truthful outcomes. `dispatchRole` persists a launch record (run, attempt, role) before spawning, binds the vendor session id the moment the stream reports it, and keeps the record on an interrupted attempt so session identity survives an interruption. A new `normalizeOutcome` classifies a launch as completed, incomplete, infrastructure-failed, timed-out, cancelled, or capability-refused, deciding from artifacts and postconditions rather than exit code. The dev-review-loop reconciles a live, finished, or uncertain prior launch before continuing — resuming the exact session when required and pausing explicitly when it is gone.
