---
"@attalabs/vinaya": patch
---

Proves, with tests, that the `AEG:TOKENS` block carries distinct rows for a Brief Author's turn and a Planner's turn alongside a Developer's, each round-tripping through `parseTokenReportEntries` into its own `LedgerRow` with no collapse or drop and a read-time sum (`sumLedger`) reflecting all three. Task 3's `--role`/`--phase` flags on `vinaya pr report --write` and its role-agnostic `writeTokensBlock` already routed multi-role rows correctly end to end — this ships the missing proof, not a behavior change; no source file changed.
