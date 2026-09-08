---
"@attalabs/vinaya": patch
---

`vinaya dev-review-loop` now finishes the loop instead of stopping at a held decision. At `publish` it posts the round's two held verdicts and a `renderSummary` comment through the forge, in order, each re-read back and re-parsed through the same `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` the merge gate calls, each idempotent across a rerun (an effect id is recorded in the outbox before each `gh` call and checked after). At `pause` it posts one comment marked `<!-- aeg:loop:paused:<reason> -->` carrying the reason and the exact `vinaya dev-review-loop --resume <pr>` command, and the process exits non-zero. `--resume <pr>` reads the held pause state and a since-posted Principal ruling off the same PR, refuses if the PR's head has moved since the pause, and otherwise re-enters the round loop at the held round. Documented in the new `apps/cli/specs/loop.md`, bound in `.vinaya/doc-owners` to `apps/cli/src/lib/dev-review-loop.ts`.
