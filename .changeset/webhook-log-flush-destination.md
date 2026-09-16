---
"@attalabs/vinaya": patch
---

The Vinaya Log's flush (`vinaya log flush`, the developer-review loop's round-end auto-flush, and `vinaya dispatch`'s own trailing flush) can now publish to a plain HTTP endpoint instead of a GitHub Issue/PR comment. Set `logPublish.webhookUrl` (optionally with `headers`) in `vinaya.config.json`, mutually exclusive with `logPublish.issue`/`pr` — no GitHub account or `gh` auth required on the receiving end. A failed POST leaves the outbox untouched and refuses; a successful one truncates exactly the posted lines. The round-end auto-flush only honors a `webhookUrl` that is also present on the repository's default branch, so a PR under review cannot redirect telemetry to its own endpoint.

**Behavior change:** `vinaya dispatch`'s trailing flush no longer posts straight onto the dispatched task's own Issue/PR by default — it now follows `logPublish` the same way the round-end flush already did, publishing nowhere (reported on stderr) when nothing is configured.

Separately, a dispatch whose child process exits without ever binding a vendor session is now classified with its own `failureReason: 'unbound'` (distinct from `'crash'`/`'timeout'`), and the dispatch heartbeat no longer reports elapsed time about a child that has already exited.
