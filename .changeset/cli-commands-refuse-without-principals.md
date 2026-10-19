---
'@attalabs/aeg-core': minor
'@attalabs/vinaya-sources': patch
'@attalabs/vinaya': minor
---

The built-in Principal is gone. `@attalabs/aeg-core` no longer exports `PRINCIPAL_ALLOWLIST`: a caller that imported it fails to compile and must read the `principals` list from the repository's `vinaya.config.json`. Every `vinaya` command and library path that decides who counts as a Principal — dispatch and brief assembly, the review loop's ruling and frozen-brief readers, `vinaya task status` and the task-tools server, `vinaya pr rule`, `vinaya issue objectives edit`, the frozen-section lock on `vinaya issue edit`, `vinaya review post` and `vinaya review status` — now reads `principals` from the default branch and refuses when it is missing, naming the fix (`add "principals": [...] to vinaya.config.json on the default branch`), or when the default-branch read fails, naming why. A repository with `principals` on its default branch behaves as before. `vinaya doctor`, `vinaya init`'s Principal note and the shipped configuration reference's `principals` row now say that without the key every Principal-deciding gate and command refuses.
