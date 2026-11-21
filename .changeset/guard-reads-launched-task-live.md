---
'@attalabs/vinaya': patch
---

A task that has been launched in the background and holds no driver lock yet no longer fails another task's test run: the end-of-run check on the real runtime directory also reads a task as live when its run record names a running process.
