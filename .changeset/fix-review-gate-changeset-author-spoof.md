---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

Security fix: `body-bare-digits`' Changesets-release exemption required both branch name and author to match, but sourced the author from an env var (`PR_AUTHOR`) that a `pull_request`-triggered workflow's own copy of the YAML can hardcode to any literal string — the same class of hole this repo's `principals` trust-anchor took three rounds to close. `review-gate` gets a matching exemption (`isChangesetsReleasePr`), but resolves the author via a live `gh pr view` fetch at check-run time, never an env var — unspoofable by the PR under evaluation. Found live during dispatch, before either version shipped.
