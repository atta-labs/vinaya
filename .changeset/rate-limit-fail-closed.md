---
'@attalabs/vinaya': patch
---

`single-plan-pr` now fails when GitHub rate-limits its read of open pull requests, naming the budget (GraphQL or REST) and when it resets, instead of passing on an empty list. `dispatch-readiness` and the dependency check `vinaya task run` makes before dispatch report a dependency whose Issue could not be read as `depends-on-read-failed` rather than as not merged; a dependency Issue that does not exist keeps its result.
