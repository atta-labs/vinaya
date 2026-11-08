---
'@attalabs/vinaya': patch
---

A version 1 run now writes the pull request's Evidence block for the head before it waits on CI, retries a write that fails within a bound, and pauses as infrastructure when the write never reaches the pull request.
