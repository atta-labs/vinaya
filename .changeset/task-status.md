---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

`vinaya task status` — every open task Issue carrying a frozen brief, its pull request, and whether its dev-review-loop is `running` (naming the driver pid), `paused` (naming the reason from the pause record), `published`, or has `no driver`, read from the outbox and the forge rather than a `ps` scan. `vinaya task status <tranche> <n>` narrows to one task and adds the last round's held or published verdict lines plus the exact resume command when paused. `--json` for the enveloped machine form.
