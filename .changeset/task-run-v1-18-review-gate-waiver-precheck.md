---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

The generated review-gate workflow's no-build pre-check job now honours the `vinaya/waiver:review` label: a pull request carrying it (unverified — actor verification stays in the trusted build job, unchanged) is built and evaluated by the real gate, instead of the pre-check holding red on a verdict comment that will never arrive. The pre-check's label and verdict-marker conditions are read from `@attalabs/aeg-core`'s `WAIVER_LABEL_REVIEW`/`VERDICT_MARKER_SOURCE` (the latter now exported) at CLI-generation time, never a second hand-typed literal of either fact. `vinaya upgrade` regenerates the workflow for adopters still on the prior (verdict-only) shape; `vinaya doctor` flags it as drifted until then.
