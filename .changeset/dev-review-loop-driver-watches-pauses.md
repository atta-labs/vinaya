---
"@attalabs/vinaya-sources": patch
---

`vinaya task run`'s own `--help` text now describes its updated behaviour: a pause no longer ends the process. It keeps running and watches the pull request, continuing on its own once a newer Principal ruling appears (or, for an infrastructure/stale-driver hiccup, after a bounded backoff) — an operator no longer has to run a separate resume command for the ordinary case. `vinaya dev-review-loop` is unaffected: it stays `task run`'s own one-shot, direct-entry command.
