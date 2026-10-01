---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

`task_start` now continues a paused run once its Principal ruling is posted, and `task_status` never shows a run a pause still holds as `exited`.

A pause whose ruling is already posted where the pause asked for it — newer than the one the pause was raised under — is continued by `task_start` itself, by handing it to the `task_resume` handler. That reuses `task_resume`'s own ruling authentication (the same ordinal-freshness check, now a shared `rulingAuthenticatesResume` predicate neither tool copies), its resolution write and its `operation: task_resume` Log event, so a continuation `task_start` takes never bypasses a check `task_resume` makes, and a stale or older approval never authenticates one. `task_resume` is unchanged and stays available for callers already using it.

When `task_start` refuses because a pause still awaits a ruling, the refusal now names where the ruling goes (the pull request, or the Issue when there is none), the exact marker line with the next ordinal, and the command that posts it.

`task_status` and `vinaya task status` read each row's state from the same pause disposition `task_start` uses: a run a pause still holds reads `paused (<reason>) — needs ruling` or `paused (<reason>) — ruled, start continues it`, with a `next` of `rule` or `start` accordingly — never `exited`, even when its driver was killed and the derivation alone would read the dead lock's exit trace.
