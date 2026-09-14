---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

The task Operator has a role, a grant, and bounded context. `roles/operator.md` and its two seam contracts (`principal-operator.md`, `planner-operator.md`) declare a task-scoped actor with process authority only — it starts selected planned work, reads grounded status, presents the persisted escalation, and requests authenticated continuation or cancellation, but never plans, codes, edits an Issue, rules, approves, or merges. Role discovery, the `/vinaya operator` command, and the generated skill all expose the same `allowed-tools` grant (the five task tools plus the status-follow read), sourced from one machine-readable `OPERATOR_TOOL_GRANT` the router's `refuseUngrantedTool` enforces. A bounded context-packet model (`context-packet.ts`, doctrine in `skills/aeg-context-packets/`) keeps a packet's authoritative constraints and version-pinned evidence index intact across compaction and continuation, and stays safe against an oversized input, scope creep, a prompt-injection attempt, missing evidence, and an ambiguous request.
