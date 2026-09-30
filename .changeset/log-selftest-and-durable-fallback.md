---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

`vinaya log selftest` proves log delivery end to end, and every folder fallback keeps its reason.

`vinaya log selftest` resolves the log destination exactly as an unattended review-loop run does in this repository — the same trust-anchor read and credential lookup, forced unattended so running it by hand proves the launch path's own resolution — then sends one marked test event to the configured server and reads it back by the event's own `event_id` through the server's cursor read. It prints `PASS` (exit 0) when the event round-trips, or `FAIL` (exit 1) with the one reason that stopped it: no server configured, the default branch's config unreadable and why, a missing ingest or read credential, the server refusing with its status, or the event not found on read-back. It never prints a credential value. The read-back uses a new `logs.readHeaders` read credential (distinct from the write-only `logs.headers`), resolved through the same `${VAR}` environment substitution. The command is listed in the CLI command reference.

When any unattended run resolves its destination to the local folder although a server is configured, the reason is now durable, not only on standard error: it is written to that task's `driver.log` and recorded in a machine-local state file that the next `vinaya doctor` reports as `last fallback: <time>, <reason>`. This closes the gap that hid a Mac Operator's review-loop rerouting every round event to the local folder with nobody able to see why.
