---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The review loop now tells the Vinaya Log it is alive and when it exits, so Mission Control can show which agents are working — across every machine reporting to one Log.

The `dev_review_loop` family gains two events. A `driver_heartbeat` records the task Issue, the pull request once one exists, the round and the phase, at most every five minutes while a driver process is alive — on a `.unref()`'d timer that never keeps the process alive and whose dropped deliveries are dropped like any other event. A `driver_exited` records the task Issue, the reason (`finished`, `paused`, `reexec`, `error` or `signal`) and the last decision, exactly once on every exit path. Both carry `meta.machine`, so a reader can tell, from the Log alone, whether a loop for an Issue is running (a heartbeat or lifecycle event within the last ten minutes with no later `driver_exited`), finished, paused or exited, and on which machine.

Only the driver emits these — never a reviewer or Developer child — and the diagnostic role-log `driver_exited:` line stays abnormal-only. A log server not yet redeployed stores either event verbatim as `unknown_version`, which a reader still parses.
