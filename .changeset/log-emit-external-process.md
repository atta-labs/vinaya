---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

`vinaya log emit <event>` records a consumer-declared event (`logs.events`) from a script or agent outside Vinaya. The field values are given as one JSON object — `--json '<json>'` or piped on standard input, never positional arguments — and are recorded through the same `emitCustomEvent` chokepoint every custom event already goes through.

A declared event exits `0` and prints the event name and the kind of destination it was recorded toward (`folder`, `server`, or `none`) — never a value. A refused event (an undeclared name, or a missing, extra, wrong-typed or too-long field) exits `1` and prints the reason class and the field names — never a value. A missing event name, unreadable JSON, or JSON that is not a flat object is a usage error: exit `2`, before anything is recorded.

A process with only `VINAYA_WORK_REF` and `VINAYA_FLOW` set in its environment — no Vinaya role, no Vinaya task — still gets a header carrying that work reference and way-of-working id, since the sink already reads both from the environment unconditionally for every caller.

`log emit` is now in the command catalog and the router coverage list; the log spec gained a worked walkthrough, "Plugging your own process into the log."
