---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

A single-fix Issue — one with no `vinaya/tranche:*` label — now carries only the rationale fields a gate checks or the brief render reads. `vinaya issue create` and `vinaya issue edit` accept it without Sizing, Project(s) + blast radius or Dependency rationale; a tranche task Issue still needs all eight fields. `checkIssueRationale` takes a `singleFix` option for this, and the `--issue` dispatch-readiness modes and the backlog brief render pass it. The render writes a "no edges" line for §3 when a single-fix Issue declares no Dependency rationale, and the agent class still resolves from the Suggested agent-class field. The planner doctrine now places single-fix Issues inside the Planner's role, under the readiness gate and the premise rule, and the rationale template shows both forms.
