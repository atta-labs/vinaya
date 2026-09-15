---
"@attalabs/vinaya-sources": minor
"@attalabs/vinaya": minor
---

The developer-review loop's round-end telemetry flush no longer defaults to publishing on the task's own Issue.

`vinaya.config.json` gains a `logPublish` key (`{issue}` or `{pr}`, plus an optional `maxChunksPerFlush`) naming where the round-end flush posts. Unconfigured — every repo's own prior default — the flush is now a no-op instead of posting unbounded comments onto the Issue the loop must itself read to dispatch the next developer round. Published volume is bounded per call, with any deferred chunks surfaced visibly rather than dropped silently, and every `gh … --json comments` read this driver makes now tolerates payloads past Node's 1 MiB default buffer.
