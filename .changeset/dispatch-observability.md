---
"@attalabs/vinaya": patch
---

`vinaya dispatch`'s child agent is no longer opaque while it runs. Its stdout/stderr are teed to a machine-local file under `~/.vinaya/dispatch-output/<effect-id>.log` (never inside the repo tree), whose path prints once to this process's own stderr; a heartbeat line reports elapsed time every minute; and a warning prints before the wall-time ceiling sends `SIGTERM`, so a timed-out dispatch is a visible, expected event rather than a silent disappearance. The default `dispatch.timeoutMs` is raised from one hour to four, giving a real task enough room to finish before the (still-enforced) ceiling fires.

The teed output is scrubbed before it lands: every chunk passes through the same `redact` the log's outbox lines already use, so a GitHub token or an `Authorization: Bearer` value a dispatched agent happens to print is replaced rather than persisted. The file is created `0600` inside a `0700` directory, is capped at `MAX_TEE_BYTES`, and a write failure mid-run disables the tee instead of taking the dispatch down with it.
