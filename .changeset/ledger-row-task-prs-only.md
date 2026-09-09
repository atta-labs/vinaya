---
"@attalabs/vinaya": patch
---

The `token-report` check's no-row refusal now applies only to a task pull request. A release pull request the changesets bot opens is no longer refused for lacking a "Token report" ledger row it could never satisfy; a task pull request with no row is still refused exactly as before.
