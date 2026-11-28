---
"@attalabs/vinaya": patch
"@attalabs/vinaya-log-sdk": patch
---

A Log writer now keeps at most one open local-copy file per signal: a run that alternates spans and events appends to one traces file and one logs file instead of starting a new file on every switch, and a file still rolls over at 8 MiB. The folder source follows both of a writer's growing files, so a follow polled between a span and an event hands both, each once, with no gap; a half-written last line is reported as abandoned only once the writer has a later file of the same signal. A position saved by the earlier folder source, and a local copy written in the earlier layout, still read with no record skipped or repeated.
