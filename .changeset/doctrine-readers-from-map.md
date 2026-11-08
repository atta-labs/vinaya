---
'@attalabs/vinaya': patch
---

A doctrine-only change selects the tests that read the changed doctrine file, and the duties that always run, instead of every test. The test inventory reads the doctrine map's rows from its source and declares each test that reads the doctrine against the rows it reads, so the doctrine files are no longer unknown inputs; a doctrine map that cannot be read keeps an explained full fallback over the doctrine folder.
