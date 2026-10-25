---
'@attalabs/vinaya': minor
'@attalabs/aeg-core': minor
---

An approved task pull request that falls into conflict with main after its loop published is picked up again. On both runners the driver keeps watching a published pull request, holding the task's lock, until it is merged or closed; when the forge reports it `CONFLICTING` the driver re-enters with no ruling, sends the Developer back with the conflicting files to merge main in, and runs the gates and both reviews again before it publishes. The Engine runner starts each re-entry as a fresh run of the task's next generation rather than resuming its completed checkpoint, and its Flow reads mergeability again before publication. Each re-entry is a new `conflict_reentry` Log event and a line in the driver log; past three for one driver, the run pauses `repeat_failure` for a person.
