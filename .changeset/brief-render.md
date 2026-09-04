---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

`vinaya brief render <tranche> <n> --surfaces <glob,...>` (task 12, #387) emits the twelve-section brief skeleton from the task Issue and the tree, with every mechanically-derivable section filled — the header, Step `0`, the dispatch-gate pre-flight line, `§4`'s file list (consumer packages, a `sha256` premise pin per file), `§7` from the doc-owners derivation, and every remaining section from the Issue's eight-field Planner rationale — refusing, naming the missing fact, when a derived section cannot be derived.

The Test Plan's `[agent]` half stops being a checkbox: `brief render` emits it as a fenced command list, and `vinaya pr report` now runs every line from the PR head and writes the command plus its actual output into a third `AEG:EVIDENCE` group — `check-evidence-fresh` recomputes it exactly, the same way it already does Group A. `test-plan` grades `[principal]` boxes only; `brief-shape` refuses a checkbox `- [ ] **[agent]**` item on a PR at or above a new rollout constant.

`vinaya pr create` now runs every registry check declaring `PR_BODY` over the body before it reaches the forge, so a body that opens is a body CI's own checks would pass too — skipped when `rings.ring1_forgeWriteInterception` is on.

The brief/report split and `vinaya brief render` are unchanged; the refreeze and frozen-body behaviour this changeset described was removed before release by PR #400 and never shipped.

The five doctrine sweeps (`reader-resolvable-prose`, `retired-vocabulary`, `doctrine-portability`, `doctrine-no-procedures`, `workspace-escape`) now declare `include: ['aeg-root/**/*.md']`.
