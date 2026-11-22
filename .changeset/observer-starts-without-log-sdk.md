---
"@attalabs/vinaya": patch
---

The round-test progress observer starts without loading the Log SDK, so on a slow host it writes its first progress line into the driver log before a short round ends.
