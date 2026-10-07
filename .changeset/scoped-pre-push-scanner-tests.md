---
'@attalabs/vinaya': patch
---

Pre-push now selects each folder-scanning test only for the kind of change that test judges, so unrelated pushes run fewer tests, and CI names every escape it finds.
