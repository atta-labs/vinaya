---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

`@attalabs/aeg-core`'s `edgesNameEachOther` (backing the cross-task `## Surface` overlap check) now recognises a slug-qualified `Conflicts-with` edge (`<slug> #n` or `<slug> n`) as naming Issue `n`, the same qualification the dispatch gate's own bare-edge rule already requires — a `Conflicts-with` edge written in that form now satisfies both gates without being written twice.

`vinaya issue create`/`edit`'s rendered-brief validation now folds an unmerged `Depends-on` or an open `Conflicts-with` PR into the write gate as an informational (`severity: 'warning'`) finding rather than a refusal of the edit — those facts describe the forge's current state, not a defect in the Issue being edited. `vinaya task run`/`task dispatch` is unaffected and continues refusing on either exactly as before.
