---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

`checkDocsWithinSurface` no longer refuses a "Docs to keep coherent" pointer for sitting outside every `## Surface` `in:` glob. The pull-request-time gate this check anticipates (`checkSurfaceScope`) only ever refuses a changed file against `out:` and never consults `in:`, so that branch enforced a premise nothing downstream shared — it only forced a Planner to widen a surface around a single doc pointer. A pointer that falls inside an `out:` glob is still refused by name.
