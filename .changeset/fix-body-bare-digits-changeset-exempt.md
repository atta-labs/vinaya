---
"@attalabs/vinaya": patch
---

`body-bare-digits` and `review-gate` are now dormant on the Changesets release PR (`changeset-release/main`) — its body is a deterministic, bot-generated rendering of already-reviewed changeset files, not agent-narrated prose, so it was never the kind of content these checks exist to catch. Every future release PR would otherwise be permanently blocked by its own bare version numbers and commit shas.

The expected release-PR author is now a repo-local `vinaya.config.json` field (`releaseActor`, defaulting to `github-actions[bot]`) instead of a hardcoded literal — found live (code review, PR #165 round 4): the hardcoded default never matched a repo whose release PRs are opened by a custom token (e.g. `RELEASE_TOKEN`) rather than the ambient `GITHUB_TOKEN`, so the exemption had never actually fired in production for a repo set up that way.
