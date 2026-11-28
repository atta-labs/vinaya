---
"@attalabs/vinaya": patch
---

The task tools server turns the Log sink's branch-derived Issue fallback off when it starts, before it serves a call, so a record it writes with no task named carries no Issue, whatever branch its checkout is on. The unused `warmupLogSink` export is removed from the sink module; the default sink, `log`, `logSync`, `drainLogSink` and the factory install are unchanged.
