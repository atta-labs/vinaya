---
"@attalabs/vinaya-sources": patch
---

`vinaya --help`'s `task run` and `dev-review-loop` catalog entries now describe issue-711 O4: `task run` composes the watching driver, which survives a pause and continues on its own once a newer Principal ruling appears (or, for an `'infrastructure'`/`'stale_driver'` pause, after a bounded backoff) rather than requiring a hand `--resume`; `vinaya dev-review-loop` itself stays `task run`'s own one-shot debug/direct entry, unaffected.
