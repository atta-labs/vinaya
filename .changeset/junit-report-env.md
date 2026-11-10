---
'@attalabs/vinaya': patch
---

The read recorder and the structure-proof runner name their JUnit report through the variable the test preload reads, so each run's report lands where it reads it back instead of being read as not passed.
