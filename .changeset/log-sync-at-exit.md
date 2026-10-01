---
'@attalabs/vinaya': minor
---

The log sink gains `logSync`, for a caller about to end the process. It appends one validated, redacted event to the same file `log()` uses before it returns. It spawns no process and awaits nothing: it reuses what the sink has already resolved and records `null` or `unknown` for anything it does not know. It never delivers. On a server destination the line waits in the local retry queue, and the next drain posts it once with its original event id. On a CI host with no destination resolved, it records nothing.
