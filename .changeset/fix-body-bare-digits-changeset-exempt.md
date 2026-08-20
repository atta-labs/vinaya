---
"@attalabs/vinaya": patch
---

`body-bare-digits` is now dormant on the Changesets release PR (`changeset-release/main`) — its body is a deterministic, bot-generated rendering of already-reviewed changeset files, not agent-narrated prose, so it was never the kind of content this check exists to catch. Every future release PR would otherwise be permanently blocked by its own bare version numbers and commit shas.
