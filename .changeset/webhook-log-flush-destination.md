---
"@attalabs/vinaya": patch
---

The Vinaya Log's flush (`vinaya log flush`, and the developer-review loop's round-end auto-flush) can now publish to a plain HTTP endpoint instead of a GitHub Issue/PR comment. Set `logPublish.webhookUrl` (optionally with `headers`) in `vinaya.config.json`, mutually exclusive with `logPublish.issue`/`pr` — no GitHub account or `gh` auth required on the receiving end. A failed POST leaves the outbox untouched and refuses; a successful one truncates exactly the posted lines.
