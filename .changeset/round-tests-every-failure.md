---
"@attalabs/vinaya": patch
---

A review round whose selected tests fail now tells the Developer every failing test file, each with its own location and failure lines, instead of only the first. The excerpts share a size limit, and any file past the list limit is counted, never dropped silently. The driver log line names every failing file too.
