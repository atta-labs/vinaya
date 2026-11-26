---
"@attalabs/vinaya-log-sdk": patch
---

A declared custom event written through a Log handle is marked reported, whatever provenance the handle was opened with; every other record keeps the handle's provenance. A custom event the handle refuses now writes one `vinaya.command.completed` record (action `log.emit`, result `refused`, the reason as its error type, the name as target only when shaped like a declared name, never a field value) and still reaches `onError`. `vinaya-log emit` with a refused event writes that record to the run's local copy and still exits non-zero.
