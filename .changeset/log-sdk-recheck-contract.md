---
"@attalabs/vinaya-log-sdk": minor
---

The Log SDK checks every record against the contract again before sending it and when reading it. `checkRecordContract` is exported: a `vinaya.*` span name, event name or attribute name outside the catalogue (and not under `vinaya.earlier.`) fails. The sender sets such a line aside with a rejected receipt naming the name, and the reader reports the record as a gap of kind `contract` without handing it.
