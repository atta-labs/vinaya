---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The dispatch-readiness check now treats a `Conflicts-with` edge as present when either task names the other, as the Issue write gate does. A task named as a conflict by an open sibling of its tranche, whose pull request is open or in flight, is no longer dispatched beside it. Both gates read the edge through one function.
