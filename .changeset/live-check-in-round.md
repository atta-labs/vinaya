---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

A task's Test plan may carry `[live]` lines — commands that need real signed-in agent sessions. The review loop runs them on its own host, only on a head both reviewers approved and before the task concludes: a failed line sends the Developer back as a new round whose head is reviewed again, a host without the vendor's subscription sign-in records the line unverified, and the merge gate holds an unverified or failed line like an unticked `[principal]` item.
