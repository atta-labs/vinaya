---
'@attalabs/aeg-forge-state': patch
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The plan grammar refuses lettered task ids, and the Surface refusal names a directory glob. Two plan-authoring gates disagreed with the tools downstream. The `Depends-on`/`Conflicts-with` edge grammar accepted a lettered id (`7a`, `2b`), while `vinaya task run` and `task dispatch` refuse any non-numeric id — a new adopter's planner split tasks into `2a`/`2b`, every gate passed, and the Operator could not start them. The edge grammar (`ID_TOKEN`/`SLUG_QUALIFIED_ID`) now accepts only a whole number, and a lettered edge id is named in a refusal at authoring time — in the `Depends-on`/`Conflicts-with` edges and in a task Issue's title — stating that task ids are whole numbers, so no plan the gates accept names a task the tools refuse.

And the Boundary-path refusal for a path outside `## Surface` said to "widen the Surface to cover" it, which the same planner read as "add the file path", while the brief renderer refuses a file path in `## Surface`. That refusal, and its recovery text, now tell the author to widen an `in:` directory glob and state that `## Surface` lists directories, never a file path.
