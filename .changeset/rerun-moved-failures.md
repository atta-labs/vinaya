---
'@attalabs/vinaya': patch
---

A push after a refused one keeps re-running only what failed and what changed when a failed test file has moved or been deleted since. It used to fall back to the full selection; a moved test now runs as the added file it is, and a deleted one is dropped.
