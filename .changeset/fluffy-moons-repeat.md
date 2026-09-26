---
"@attalabs/aeg-core": minor
---

Add a `log` subpath export, so a consumer can import the log module's schema, identity and read-side classification (`recordIdentity`, `classifyStoredLine`) without pulling in the package root's filesystem and forge dependencies. Nothing about the root export changes.
