---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

`verify-registry.ts --scaffold` now classifies `apps/cli/src/checks/bin/*.ts` candidates, not just `packages/aeg-core/bin/*.ts`, `.husky/*`, and `.claude/hooks/*.sh` — the location most core check bins actually live in. A registered check's bin there now gets a correctly-ringed stub row via the new `CLI_CHECK_RING` mirror table (`@attalabs/aeg-core`), the same no-guess-unless-derivable discipline `GATE_AUDIENCE` already applies to the other prefix. Hand-authoring an `enforcement.md` row, or relocating a check's implementation across packages, is no longer necessary just to satisfy the classifier's glob.
