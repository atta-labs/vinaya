---
'@attalabs/vinaya': patch
---

A ruling that resumes a paused run makes the next round-test step run the round's tests again, even for the same round and head, instead of reusing the result recorded before the pause; a reviewer retry with no ruling in between still reuses it.
