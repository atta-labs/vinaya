---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": minor
---

`vinaya.config.json` gains an optional `projects` array — a config-native home for project metadata (`name`/`description?`/`path?`), alongside `.vinaya/projects.md` rather than instead of it. `vinaya init product <name>` now appends an entry here at the same time it appends the registry row, through the same plan/confirm diff discipline. `vinaya doctor` reports (at `info` severity, never an error) when a registry row and a `projects` entry name the same project but only one of the two exists.

Additive only: an existing `vinaya.config.json` with no `projects` key still validates unchanged, and no gate or resolver reads this key — it is display metadata only.
