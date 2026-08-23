---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

`vinaya init product` no longer creates a `project:<name>` label, and no longer needs a GitHub remote or credentials. Project is a **field, not a label**: the `project:*` family was dropped outright, `declaredProjects` resolves a task's project from the Issue body's `**Project:**` field, and `list-tasks.ts` explicitly ignores a residual `project:*` label. The command's only forge-reaching op was therefore creating a label no shipped consumer reads, while making an otherwise purely local command require a remote — and, when none was configured, emit a warning about skipping work that did not need doing. What it writes is unchanged: the `.vinaya/projects.md` row, still deliberately outside the ownership manifest so `eject` never reverses adopter-declared data. Existing repos keep whatever `project:*` labels they already have; nothing deletes a forge label that may be in use elsewhere. Adopters relying on `project:*` for issue filtering should apply it themselves going forward.
