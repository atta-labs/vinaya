---
'@attalabs/vinaya': patch
---

`vinaya task run --widen-surface` now stops a driver that is halted at the very escalation being widened, then widens and starts the run, instead of refusing until a person kills that process by hand. A driver at any other point is still refused and never touched.
