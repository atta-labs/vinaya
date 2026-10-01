---
'@attalabs/vinaya': patch
---

A `SECRETS: none found — atta-labs/secret-scan passed` line is no longer refused because its trailing note contains a word such as "no"; only the word right after the check's name decides pass or fail, for both the review loop and `vinaya review post`.
