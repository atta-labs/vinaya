---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

`verify-dispatch`'s dispatch-readiness gate (and the shipped `vinaya check dispatch-readiness` / `vinaya check first-push-dispatch` adapters) now resolve the documented cross-tranche `Depends-on`/`Conflicts-with` form with a bare task id (`<slug> <n>`) — previously it parsed as valid, resolved to nothing, and blocked forever with a message claiming the dependency was "not merged yet" even after it had genuinely merged (#196). An edge that still cannot be resolved (unknown slug, or unknown task id within a known slug) now reports `UNRESOLVABLE`, quoting the edge text, instead of the misleading "not merged" claim — still blocking (the conservative default is unchanged), just honest about why.
