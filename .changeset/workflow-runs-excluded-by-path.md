---
"@attalabs/vinaya": patch
---

The review loop and the Operator read tell the managed review-gate, on-verdict and body-check workflows apart by their workflow file, not their name: GitHub reports those workflows' per-pull-request run name as the run's name, so they were counted as failed CI and no task reached review.
