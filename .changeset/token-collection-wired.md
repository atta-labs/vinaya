---
"@attalabs/vinaya": minor
---

New `token-collection-wired` core check (ring 0, part of the managed `pre-commit`/`pre-push` hooks' `vinaya check --all --local`): when the token-metering probe (`resolveMeteringCapability`, `@attalabs/aeg-core`) finds a wiring point resolved — a transcript pointer that names a path — but cannot reach what it names, the commit is refused with the wiring named. A host never wired to meter at all (no pointer, no `--transcript`) passes unchanged: that is the sanctioned operator-metered case, not a defect.

Local and offline only: no PR body is read (none exists yet at pre-commit) and no network call is made.
