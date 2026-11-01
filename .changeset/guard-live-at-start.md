---
'@attalabs/vinaya': patch
---

The test suite's real-runtime check no longer fails a run because another task's loop, live when the test process started, ended before the check: the live loops read when the process starts are exempt alongside those read at the check, while a task folder no live loop owned at either read is still flagged.
