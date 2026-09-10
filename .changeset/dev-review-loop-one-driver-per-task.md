---
"@attalabs/vinaya": patch
---

`devReviewLoop` now refuses to start when another driver for the same task is already running on this machine, naming that driver's pid and start time on stderr rather than starting a second developer/reviewer pair against the same outbox. The guard is a pid record under `<outboxRoot>/dev-review-loop/<task>/driver.pid.json`, written at start and cleared in one `finally` on every exit (a normal return, a pause, or an uncaught error); a record whose pid no longer answers a liveness probe is treated as absent, so a crashed driver never blocks the next start, and this run takes it over — also announced on stderr, naming the stale pid and start time.
