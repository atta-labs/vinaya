---
'@attalabs/vinaya': patch
---

A run's setup step no longer pauses when the readiness check fails only because a GitHub read did not complete: it checks again through the stop decision, within the same bound a round's forge reads use, and pauses only once that bound is spent. A real not-ready still pauses at once.
