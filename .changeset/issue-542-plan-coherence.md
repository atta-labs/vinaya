---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

`vinaya issue create`, `vinaya issue edit`, and `vinaya issue objectives edit` on a task Issue now render the twelve-section brief that draft body would freeze into and grade it with the same `brief-shape` gates `pr create` applies, before the write reaches the forge — a body that would freeze into a brief `pr create` refuses is now refused at the Issue instead, naming the section and the rule. Dormant for a tranche-labeled task Issue and outside a real repo checkout (no brief template, no resolvable owner/repo).

`@attalabs/aeg-core` gains three new Issue-content predicates: `checkObjectivesRespectBoundary` (an Objective, Part, or Test plan line naming a path the Boundary's `Out:` clause or the Surface's `out:` list excludes is refused, quoting both lines), `checkNoForeignTaskOwnership` (a Traps/Stop-and-escalate/Boundary sentence assigning ownership of this task's own objective to another task is refused), and `checkPartsCoverageAndSequence` (an objective no Part cites, or Parts numbered out of sequence, is refused) — wired into both `vinaya issue create`/`edit`'s validated write path and this repo's own `open-issue.ts` dogfood gate.
