---
'@attalabs/vinaya': patch
---

A passing local test run now lets the next push on the same branch run only what changed since, and only while that run's policy, lockfile and runner context still match.
