---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
"@attalabs/aeg-forge-state": patch
"@attalabs/aeg-types": patch
"@attalabs/vinaya-sources": patch
---

`Doc-neutral:` now clears a fired C5 doc-coverage binding in the merge-blocking check, not only in `verify-docs`. `evaluateC5` verifies the declaration by reading the matched file's diff, and both check bins called it without that argument — so the gate's own failure message instructed the user to declare `Doc-neutral:` while that declaration could never succeed in CI. Both bins now pass a shared per-file diff closure, against the ref that actually produced the changed-file list rather than the requested base (both re-resolve to `main` when `origin/main` yields nothing).
