---
'@attalabs/aeg-forge-state': patch
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

Dispatch checks read the real prior-tranche archival state. One shared resolution serves the standalone dispatch verifier and both CLI checks: `vinaya check dispatch-readiness` refuses dispatch on an unarchived prior tranche, and a failed read it depends on fails as `severity:infra` instead of passing by default. The first-push check refuses on the same unarchived tranche and treats a failed read as an unreachable forge.
