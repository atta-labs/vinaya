---
'@attalabs/vinaya': patch
---

A native local push stops after the first runner group whose runner fails and refuses at once. The tests of the groups it never started stay obligations of the next push and are never credited or reported as failing; the refusal says how many tests and runner groups were not run. CI's schedule still runs every group.
