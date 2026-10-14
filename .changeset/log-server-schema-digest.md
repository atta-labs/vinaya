---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The log package computes a structural digest of the event validator (`logEventSchemaDigest`), the log server reports it on its stats route and replays rejected rows on request, and `vinaya log selftest` and `vinaya doctor` compare the server's digest with the CLI's own so a server deployed from an older schema is visible.
