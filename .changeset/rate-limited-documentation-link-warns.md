---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

The Issue write gate's Documentation link probe now reads response headers and treats a rate-limited reply (429, a 403 with `x-ratelimit-remaining: 0`, or any `retry-after`) as a warning that the link is re-checked on the next gate run, never a refusal. Every other non-success status, including a plain 403, still refuses.
