---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": minor
---

New command: `vinaya pr verify-evidence <n>` — proves a pull request's
`AEG:EVIDENCE` region was machine-generated, by regenerating the report against
the working tree and comparing.

`evidence-fresh` closes fabrication for Group A by recomputing the diff stat and
byte-comparing it, but its own docstring records that a Group B section which was
never actually run is not detected — only a stale one is. It cannot do more:
`evidence-fresh` is registered in `coreCheckRegistry()` and `pr report` runs
`vinaya check --all --diff-only`, so a check that regenerated the block would run
the suite containing itself. This command lives outside the registry, which is
what lets it close that gap without the recursion.

Comparison is set-equality over normalised lines rather than a byte diff, because
three sources of false difference were measured against a live pull request:
absolute paths embedded in warnings differ per checkout, warning order is not
stable between runs at the same head, and `AEG:TOKENS` appends by design so
whole-body comparison always differs. A pure reordering is reported as a match —
a reordered warning set is not a fabrication, and flagging it would train readers
to ignore the tool.

Exits 0 on MATCH, 1 on DIFFERS or when the body carries no block.
