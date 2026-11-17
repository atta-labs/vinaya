---
"@attalabs/vinaya": patch
---

A ready push that runs no local tests still runs every Test Plan command, and the Engine's Evidence names each one in Group C (none when the Test Plan lists no command, with the no-local-tests state noted under Group B), so `evidence-fresh` passes for repositories that declare no test runner.
