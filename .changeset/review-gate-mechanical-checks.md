---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": patch
"@attalabs/aeg-forge-state": patch
"@attalabs/aeg-types": patch
"@attalabs/vinaya-sources": patch
---

**Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `mechanicalChecks: MechanicalCheckStatus[]` field — every check-run reported for the PR's current head, excluding the caller's own review-gate check-run. A caller that does not supply it no longer compiles, the same required-not-optional discipline `headSha` already established (#73): an optional field that silently skipped the mechanical-check requirement on absence would fail open. `checkReviewGate` now also requires every reported mechanical check to be green (`bucket === 'pass'`) — an empty array does not count as clean, since there is no proof to point to. A red or absent mechanical check fails the gate the same way an unclean or unbound verdict does, naming which check is not green, or that none have reported yet. The `vinaya/waiver:review` label still short-circuits to pass unconditionally, regardless of mechanical-check state. Both `apps/cli/src/checks/bin/check-review-gate.ts` and `packages/aeg-core/bin/verify-review-gate.ts` now fetch check-run status via `gh pr checks --json name,bucket`, filtering out their own review-gate check-run name before calling in — that exclusion lives in the CLI shims, not in `aeg-core`'s pure logic, since `aeg-core` ships to every adopter under a different workflow name.
