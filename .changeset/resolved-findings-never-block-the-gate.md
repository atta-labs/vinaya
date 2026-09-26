---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": patch
---

A finding a reviewer marks `resolved` no longer blocks the merge gate. Verdict extraction now reads each finding's id and re-review state beside its severity and location, and one shared `consequentialFindings` filter — the single definition of "counts toward policy" — is applied by the merge gate, the loop's publication self-check, and verdict derivation alike. An APPROVE/PASS whose only findings at or above the repository's threshold are marked `resolved` now passes the gate and publishes, exactly as it already made `vinaya review post` derive APPROVE/PASS; a finding in any other state (`open`, `fix-claimed`, `reproduced`, or carrying no state token) still blocks, so a reviewer cannot clear a real blocker by relabelling it anything but `resolved`.
