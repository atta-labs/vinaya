---
"@attalabs/vinaya-log-sdk": patch
---

The stored-record contract module also exports the record check on `vinaya.*` names (`reservedNamesOf`, `checkReservedNames` and the `ReservedName` type) and `traceIdFor`, so the package entry exports them and a reader that loads only the contract modules — the Log server's Worker — reaches them through the same module as the store.
