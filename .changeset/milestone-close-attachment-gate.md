---
"@attalabs/vinaya": minor
"@attalabs/aeg-forge-state": minor
---

`vinaya milestone close --slug <slug>` replaces the raw `gh api .../milestones/<n> -X PATCH -f state=closed` recipe `tranche-archivist.md` used to run on faith. It resolves the target Milestone the same legacy-or-intent-declared way `vinaya issue create`'s auto-attach does, fetches the tranche's labeled Issues and the Milestone's natively attached Issues, and refuses to close on any mismatch — naming each unattached or foreign Issue and its repair path (`gh issue edit <n> --milestone <title>`, or `vinaya milestone adopt`) — before the PATCH ever reaches the forge. The mismatch diff itself is a new pure function, `checkMilestoneAttachment` (`@attalabs/aeg-forge-state`): no network inside it, both Issue lists are fetched and injected by the caller. `--validate-only` verifies attachment without writing.
