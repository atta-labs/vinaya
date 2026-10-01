---
'@attalabs/vinaya': patch
---

The dev-review-loop no longer casts a review verdict under the built-in default policy when it cannot read the repository's real one. Before, a failed read of the default-branch `vinaya.config.json` (a forge outage, a rate limit, a timeout) was swallowed to `null`, indistinguishable from a repository with no config, so the loop ran under the `BLOCKER` default; a verdict cast that way is rejected by the merge gate, which reads the real policy, and a clean review could not merge.

`reviewPolicy` now reads through a new `loadTrustAnchorConfigOrThrow`, which tells a genuine read failure (any error other than a `404`) apart from a missing config file or one without a `reviewPolicy` key. A failed read is retried once and, if it still fails, pauses the task with `reason: infrastructure` naming the read's own error — dispatching no reviewer and casting no verdict — so a later `vinaya task run --issue <n>` resumes and casts verdicts under the repository's real policy. A missing or policy-less config still runs under the built-in defaults exactly as before, and `loadTrustAnchorConfig` is unchanged for its other callers.
