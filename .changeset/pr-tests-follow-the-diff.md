---
'@attalabs/vinaya': patch
---

The pre-push hook's test selection takes an optional depth, defaulting to the hook's own depth one, so a pull request's CI run can reuse it at full depth.
