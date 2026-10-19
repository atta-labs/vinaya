---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

The `surface-scope` check now fails a task-branch pull request that changes a protected administrative path (`vinaya.config.json`, `.vinaya/doc-owners`, `.github/`, `aeg-root/`) that no `in:` glob of its Issue's Surface covers, even when the pull request body's beyond-Surface record lists it — the same rule the broker applies to a push. The protected list and the path normalization now live once in `@attalabs/aeg-core` (`PROTECTED_ADMIN_PATHS`, `normalizeTouchedPath`, `isProtectedAdminPath`), and `SurfaceScopeResult` gains a protected-path violation.
