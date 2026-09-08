---
"@attalabs/vinaya": patch
---

`vinaya dispatch`'s child agent is no longer opaque while it runs. Its raw stdout/stderr are teed to a machine-local file under `~/.vinaya/dispatch-output/<effect-id>.log` (never inside the repo tree), whose path prints once to this process's own stderr; a heartbeat line reports elapsed time every minute; and a warning prints before the wall-time ceiling sends `SIGTERM`, so a timed-out dispatch is a visible, expected event rather than a silent disappearance. The default `dispatch.timeoutMs` is raised from one hour to four, giving a real task enough room to finish before the (still-enforced) ceiling fires.
