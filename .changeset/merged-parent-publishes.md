---
'@attalabs/vinaya': patch
---

A task branch that merged its moved parent publishes instead of pausing: when the new base contains the base the task was cut from, lies on the default branch, and the head descends from the recorded head and the new base, the driver accepts it and re-records the base and head. Any other moved base is still refused.
