---
"@attalabs/vinaya": patch
---

A paused run that waits for a ruling now reads the forge less and less often, up to one read every five minutes, and waits the full five minutes after a read that says the forge's rate limit is spent. It still reads its own cancel and resolution on the configured interval, and acts on a ruling at the next forge read.
