---
'@attalabs/vinaya': patch
---

Round tests on one host now run in as many slots as the host's memory and processors allow (one per 4 GiB and per two logical processors, at least one), instead of one at a time. A run that waits for a slot logs the wait; a running round test narrates its test files into the driver log as a ready push does, and ends with one line naming the outcome, the selected file count and the wall time.
