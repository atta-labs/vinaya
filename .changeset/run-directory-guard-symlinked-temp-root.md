---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

`mkdirNoSymlinks` now takes a `trustedRoot` boundary: a symlinked ancestor strictly above it (an operating-system-owned default temp root, such as macOS's `/var` -> `/private/var`) is resolved and its real target ownership/mode-checked rather than refused outright, while a symlink at or below `trustedRoot` is still refused unconditionally. Every run-directory writer in `@attalabs/vinaya` now passes its own `runtimeDir` as that boundary, so creating a run directory under the platform's own default temp root no longer throws.
