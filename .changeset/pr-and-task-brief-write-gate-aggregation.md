---
"@attalabs/vinaya": patch
---

`pr create` and `pr edit` now refuse once with every failing finding — the forge-write gates (legacy brief markers, the configured brief-schema sections, the whole-body bare-digit scan, and, on `pr create`, the Premise-own-additions check) and the PR-body registry checks all grade the same bytes and report together, instead of stopping at the first group that fails.

`task brief` now runs the same Issue write gate `issue create`/`issue edit` already enforce over the Issue's live body before ever freezing a brief from it, so a defect that gate would refuse — a bad title, a blast-radius violation, a whole-suite Test plan line — is refused by `task brief` too, with the same findings, rather than silently reaching a frozen brief.

`task brief --supersede` accepts a new `--surface-in <glob,...>` addition that widens the Issue's `## Surface` `in:` list (union with whatever is already there, never a narrowing), validated by the same write gate, and re-freezes the brief from the widened Surface in the same command — the one self-serve way to broaden a frozen task's Surface, since `issue edit` itself locks `## Surface` once a brief is frozen.
