---
"@attalabs/aeg-core": minor
---

A typed task-tool catalog — `task_start`, `task_status`, `task_escalation_read`, `task_resume`, `task_cancel` — is the one place a task-operator tool's name, input/result/error schema and boundaries are written, each with schema-valid examples and a handler-binding pointer. `task_status` and `task_escalation_read` are bound to a real read interface over today's outbox records; the three mutating tools refuse every call with a typed `capability_unavailable` error until a control store exists for them to act on.
