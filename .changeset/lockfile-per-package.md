---
'@attalabs/vinaya': patch
---

A lockfile change selects only the tests that read an installed package whose lockfile entry changed. The read recorder keeps a read under the installed dependencies per package (`bun.lock#zod`) instead of as the whole lockfile, which made every test a reader of it, so any dependency change selected every test.
