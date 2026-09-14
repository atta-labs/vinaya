---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

Review evidence now binds base identity and a complete, durable policy identity. The review-input manifest gains a base commit (`baseSha`) and folds the round-policy field (`maxRounds`) into `policyDigest`; `compareManifest` applies a bounded acceptance rule — an exact-head match also requires the base to match (a base-only change invalidates), while a proven patch-identity rebase tolerates a base move (an equivalent rebase keeps). The manifest is persisted per round as a new `manifest` control-store record kind (`writeManifest`/`readManifest`/`parseManifestRecord`), and the merge gate, the dev-review-loop self-check, and publication all apply the same binding on every field.

New `@attalabs/aeg-core` exports: `isBoundToBase`, `parseManifestRecord`, `writeManifest`, `readManifest` (plus the `ManifestRecord`/`ManifestInput` types). Verdict comments carry a `Judged base:` line; a comment cast before this change (no base echo) needs one fresh review round against a resolvable base, the same one-time transition every other manifest field already took.
