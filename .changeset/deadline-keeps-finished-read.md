---
"@attalabs/vinaya": patch
---

A deadline that expires while the process was busy keeps a read that already finished, so a run's Log no longer falls back to the local folder after a slow start.
