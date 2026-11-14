---
'@attalabs/vinaya': patch
---

A test process's release of its fixture run directory no longer reports a cleanup failure when another test process's startup sweep deletes part of the released tree while the release restores write to it or removes it. When either step fails, the release runs both once more within the same process budget, and counts as done when the released tree is gone after either attempt; a tree still there after the second attempt records its cleanup failure as before.
