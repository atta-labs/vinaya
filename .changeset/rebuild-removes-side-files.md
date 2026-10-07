---
'@attalabs/vinaya': patch
---

`vinaya sync --rebuild` now removes the cache's write-ahead-log and shared-memory side files together with the database, so a rebuild opens a fresh cache on macOS instead of failing with "disk I/O error".
