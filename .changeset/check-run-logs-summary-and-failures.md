---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

A check run now records one `gate` `summary` event and a `gate` `checked` event only for each check that did not pass, and a forge write records one `effect` event instead of three, so the Vinaya Log stays inside a log server's free daily write limit.

The `summary` carries how many checks ran, passed, failed and were skipped, the names of the checks that did not pass, and the run's total duration. A passing or skipped check records no event of its own. A failing check's `checked` event keeps its `reason`, fingerprint and commit exactly as before. A forge write records a single `effect` `verified` event whose `outcome` is `success`, `failure` or `uncertain`; the `attempted` and `observed` events still parse, so lines stored earlier still read, but nothing records them any more. The local effect records a write recovers from are unchanged.
