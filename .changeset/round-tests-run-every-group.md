---
'@attalabs/vinaya': patch
---

A review round's test run now runs every runner group, a failing one included, through the adapter's new `run --all-groups`. A push still stops after the first failing group. Before, a red group in a round left every later group unconfirmed, so the next round re-ran all of them instead of only what failed or never ran.
