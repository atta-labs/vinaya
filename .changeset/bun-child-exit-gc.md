---
'@attalabs/vinaya': patch
---

Pin repository and CI execution to Bun 1.4.4, which contains the synchronous-spawn event-loop fix, and add a bounded GC/child-exit regression probe. This prevents test groups freezing when streams from earlier tests are finalized during a synchronous child spawn.
