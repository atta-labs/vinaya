---
'@attalabs/vinaya': patch
---

The review loop's round loop, its rate-limit and outage waits, its CI gate reads and reruns, its round report and its reviewer turn now run from their own modules next to the driver, over one per-run context that holds the locals they share. The loop behaves as before: the same steps, decisions, log events and prompts, and every name the driver file exported is still exported from it.
