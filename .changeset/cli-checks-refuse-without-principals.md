---
'@attalabs/vinaya': minor
---

The checks that decide who counts as a Principal — review gate, dispatch readiness, first-push dispatch, coherence, documentation coverage (both modes), evidence freshness, brief shape, test plan and the Principal test-plan wait — no longer fall back to a built-in Principal. They read `principals` from `vinaya.config.json` on the default branch through one new resolver, `resolveTrustedPrincipals`, which throws `PrincipalsUnresolvedError` with `kind: 'not-configured' | 'read-failed'` instead of guessing.

With no `principals` configured (no repository resolves for the read, the default branch has no `vinaya.config.json`, the file has no `principals`, or it fails the configuration schema), every one of those checks writes one `error` check-error line naming the fix — add `"principals": [...]` to `vinaya.config.json` on the default branch — and exits 1. The list resolves before the review and documentation waivers are judged, because the waiver's actor check needs it: a repository with no `principals` cannot waive either gate.

When the read itself fails (no `gh` authentication, an empty CI token, the network), the trust decisions — the review gate, evidence freshness, the frozen-brief resolution behind brief shape, test plan and the Principal test-plan wait, and the pull-request documentation-coverage waiver — refuse the same way, naming the reason. The push-time checks — first-push dispatch, coherence (rule A1 is not evaluated), dispatch readiness and push-mode documentation coverage (the waiver is treated as not active) — write one `warning` line naming the failed read and leave their exit to the rest of the check, so a push is never blocked by an unreadable forge.

Inside the Developer sandbox `gh` cannot authenticate, so a Principal read there is a failed read: the trust-decision checks refuse there and the push-time checks warn. On a fork pull request the CI token is empty, so the same holds: every trust-decision check refuses, naming the reason, while the push-time checks warn. With `principals` configured on the default branch, every check behaves as before.
