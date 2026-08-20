---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

Security fix: `body-bare-digits`' and `review-gate`'s Changesets-release exemptions both require branch name and author to match, but an earlier draft of `body-bare-digits` sourced the author from an env var (`PR_AUTHOR`) that a `pull_request`-triggered workflow's own copy of the YAML can hardcode to any literal string — the same class of hole this repo's `principals` trust-anchor took three rounds to close. That draft also never declared `PR_AUTHOR` in the check's registry `env` allowlist, so the runner silently stripped it before the check ever ran in real CI — the exemption never actually fired. Both checks now resolve the author via a live `gh pr view` fetch at check-run time instead, never an env var — unspoofable by the PR under evaluation, and immune to allowlist-declaration drift. A new registry-coupling test bans `process.env.PR_AUTHOR` from ever appearing in any check bin's source again. Found live during dispatch, before any version shipped.
