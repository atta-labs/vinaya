---
"@attalabs/vinaya": patch
---

A plan review round on Claude Code now finds the subscription login on macOS. The round's agent receives the same parent environment variables as every other agent the harness launches, including `USER` and `LOGNAME`, which the Keychain lookup needs, instead of `PATH` and `HOME` alone.
