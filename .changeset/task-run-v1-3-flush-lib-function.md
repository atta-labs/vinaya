---
"@attalabs/vinaya": patch
---

The log flush's own body — chunking, posting, the audit trail, truncation — now lives in `flushOutbox`, an exported lib function (`apps/cli/src/lib/log-flush.ts`) that takes an Issue or pull-request target and returns what it posted; `vinaya log flush` is reduced to argv parsing around it. `devReviewLoop`'s round-end flush calls `flushOutbox` in-process instead of spawning a `vinaya log flush` subprocess of its own CLI entry, and `vinaya dispatch`'s trailing flush calls it directly too. On attach, a held REQUEST-CHANGES round from a prior process is now recovered from disk instead of reset to round 1: a moved head advances straight to that round's reviewers without redelivering its findings to the developer, and a second attach finding the same unchanged head pauses `no_progress` rather than repeating the redelivery toward a confidence collapse.
