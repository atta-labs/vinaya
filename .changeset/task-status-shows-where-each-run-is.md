---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

Task status shows where each run is, as one table: its round, its phase, how long it has been in that phase, the newest confidence any record still carries, and what that phase has typically taken on this repository's recently merged tasks. `vinaya task status` renders one table for both its list and single-task forms; the `task_status` result carries the same facts as structured fields (`round`, `phase`, `minutesInPhase`, `lastConfidence`, `phaseHistory`), all optional, so a client written against the earlier shape still parses. Typical times are history — a median with its sample count, computed from principal-authored round markers and verdict comments on merged task pull requests, bounded and cached per process — and a phase with too few past intervals, or a forge read that failed, shows no typical time rather than an invented one.
