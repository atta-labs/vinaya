---
'@attalabs/vinaya': patch
---

A test process's release of its fixture run directory no longer reports a cleanup failure when another test process's startup sweep deletes part of the released tree while the release restores write to it or removes it. Restoring write is now best effort: the removal always runs after it, and whether the released tree is gone decides the attempt. A tree still there gets one more attempt, restore and removal, within the same process budget; the release counts as done when the tree is gone after either attempt, and a tree still there after the second attempt records its cleanup failure as before, including when the removal exited cleanly but left the tree.
