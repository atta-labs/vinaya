---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

A driver that cannot post its pause or escalation comment now retries the post with backoff for a bounded period instead of exiting the whole process — the local pause record is written first and stays authoritative regardless of whether the comment ever lands, and the next `--resume` posts the missing copy, once, before continuing.

A developer session that ends because the vendor could not be reached (a launcher-classified `'connection-failed'` exit, detected from the vendor's own confirmed-live connection-retry signal) is waited-and-re-dispatched on the same session, bounded by the existing infrastructure-retry budget, and only pauses with that reason once the bound is exhausted — it never records a stop decision the developer did not make.

Both paths log a new `dev_review_loop` event, `infrastructure_retry`, naming the failure kind, the attempt count and the outcome — additive to the schema, so a line recorded before this change still parses.

A driver started from a ruling authenticates it once, at `--resume`'s own start; a later stale-driver re-exec of that same run no longer rebuilds `--resume <pr>` (which re-ran the resume gate against an already-consumed resolution and crashed with no pause) — it always reattaches with `--task <n>` instead, the same door an ordinary restart already uses.
