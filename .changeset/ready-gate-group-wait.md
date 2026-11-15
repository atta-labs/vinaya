---
'@attalabs/vinaya': patch
---

The ready-gate wrapper case waits, within three seconds, for the wrapper's process group to be gone instead of reading it once, so it no longer fails while a killed child is still waiting to be reaped.
