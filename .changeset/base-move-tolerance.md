---
"@attalabs/aeg-core": patch
---

A review verdict now binds to a PR even when the base branch advances, as long as the PR head remains unchanged. The base commit is still recorded for audit, but moving the base alone no longer invalidates a verdict. Only when the candidate head does not bind at all (a different revision, not an equivalent rebase) is the base checked as a separate fact. Abbreviated base echoes that do not properly prefix the current base still fail-closed, preserving safety against corrupted or stale abbreviations.
