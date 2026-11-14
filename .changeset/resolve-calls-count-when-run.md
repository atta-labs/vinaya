---
'@attalabs/vinaya': patch
---

The read recorder no longer counts every folder a test listed as scanned just because a source it loads mentions `Bun.resolve`, `Bun.resolveSync` or `bun:ffi`: the listing probe now wraps those functions and the `dlopen` of `bun:ffi`, and only their first call marks the process wholly scanned. A resolve through the module meta object or a require function, or a test-runner module mock, whose specifier is one string literal now counts only the folders that specifier can resolve into — the folder a relative specifier names, or the repository root and a workspace package's subpath folder for a bare one. A computed specifier, and Bun's file-system router, still count every listed folder.
