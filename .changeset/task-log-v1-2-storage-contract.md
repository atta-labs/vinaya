---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

Persist and read Vinaya Log event batches without silent loss or duplicate identities.

`packages/aeg-core/src/log/store.ts` adds a typed storage contract — `append`, `readPage`, `acknowledge` — with stable record identities, an idempotent append, overflow diagnostics, version/provenance-validated read-back that keeps unknown-version records for diagnosis, and a deterministic in-memory fixture backend. The GitHub adapter behind `vinaya log flush` implements the contract: it classifies and re-redacts each line through it and skips re-posting a chunk whose marker already exists on the forge, so a flush retry after a lost acknowledgement no longer repeats a remotely accepted batch.
