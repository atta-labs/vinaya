---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

A task's Test plan may carry `[live]` lines — commands that need real signed-in agent sessions. The review loop runs them on its own host after the gate is green and before review: a failed line sends the Developer back, a host without the vendor's subscription sign-in records the line unverified, and the merge gate holds an unverified or failed line like an unticked `[principal]` item.
