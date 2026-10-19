---
'@attalabs/vinaya': minor
---

`vinaya archive` links the newest frozen brief comment, authored by a configured Principal, on the Brief line of the provenance block it posts; a missing brief or an unreadable comment list still posts the block and closes the Issue with the Brief line reading DANGLING. The command resolves the Principal list from the default branch's configuration before any write and exits non-zero, posting and closing nothing, when that list cannot be resolved.
