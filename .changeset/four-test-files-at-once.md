---
'@attalabs/vinaya': patch
---

Test files now run four at a time by default, on CI, a local push and a review round alike. `VINAYA_TEST_CONCURRENCY` still overrides the default, and setting it to `1` restores one file after another. A review round sets its own file concurrency, four capped at the host's logical processors, and the number of rounds a host tests at once now counts test processes: max(1, min(floor(logical processors / 4), floor(total memory / (4 × 512 MiB)))), so the test processes of every round together never exceed the host's logical processors. A 12-processor, 36 GB machine runs three rounds of four files; a host with fewer than four processors runs one round at as many files as it has processors. A round testing alone runs about 3.1 times faster; when several rounds test at once each is faster than before, but by less.
