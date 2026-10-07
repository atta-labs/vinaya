---
'@attalabs/vinaya': patch
---

A paused driver no longer retries a resolution that was already consumed. It re-reads the current pause, moves past the consumed ruling, and resumes only on a strictly newer one; the refusal now says what consumed the resolution and when.
