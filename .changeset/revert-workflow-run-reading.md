---
"@attalabs/vinaya": patch
---

Revert the workflow-run reading of the review loop's CI conclusion: it counted the review gate and body-check workflows, whose runs carry a per-PR run name, as failed CI, so no task reached review.
