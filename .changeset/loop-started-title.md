---
'@attalabs/vinaya': patch
---

A loop's `loop_started` Log event now carries its task Issue's title, read once when the loop starts, so a run can be named from that one event. The field is optional: older events without it still validate, and the log server stores it once redeployed with this schema.
