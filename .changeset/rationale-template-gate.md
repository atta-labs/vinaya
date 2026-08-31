---
"@attalabs/vinaya": patch
---

`aeg-root/templates/issue-rationale-template.md` now passes the ring-0 gate it exists to satisfy: `Tier:`/`Project:`/`Type:` are lifted above the template's first `##` heading (into the header block `vinaya issue create`/`edit` actually reads), instead of sitting past it where `vinaya issue create --validate-only` refused with a `Project:` header-block error on every filled copy. `Type:` no longer cites `vinaya/type:*` — no such label exists on the live forge — and is now free-text task-type metadata, not a label claim.
