---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

The Vinaya Log's event envelope gains `meta.schema: 2` — stable per-event identity, an opaque per-process identifier, task/run/attempt/parent lineage, input versions (mirroring `review-input-manifest.ts`'s field set), and a trust-provenance value — alongside the unchanged `schema: 1` read shape, which every event recorded before this change keeps parsing under. `buildHeader` now builds `schema: 2` for every event going forward; none of the new fields are wired to a real producer yet (`control-store-v1`/`worker-isolation-v1` do that), so they read back `null`/`'unavailable'` honestly rather than an invented value. Six new event kinds ship typed schemas — `gate`, `operation`, `usage`, `role_attempt`, `handoff`, `effect` — and a `verdict` outcome's findings gain optional `severity_scale`, `policy_treatment`, `confidence`, `confidence_scale`, `confidence_source` fields, all additive to the pre-existing `id`/`severity`/`state` shape.
