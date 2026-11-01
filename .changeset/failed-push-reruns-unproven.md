---
'@attalabs/vinaya': patch
---

The progress observer counts only the test files a runner group was scheduled to run: a header-shaped line a test prints from an inner fixture run is never counted or shown, a Vitest group's per-file lines count like Bun's headers, and each group's count is reconciled to its report when it ends, so a finished run's done count equals the files it executed. Failed-tests records gain optional fields marking a list that holds every unconfirmed test of its run, its unreported files and its run's start; a record without them keeps the older rule.
