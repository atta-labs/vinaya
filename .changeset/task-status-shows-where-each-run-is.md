---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
---

Task status shows where each run is, as one table: its round, its phase, how long it has been in that phase, whether that phase is still where the run is or the last one a stopped run recorded, the newest confidence any record still carries, and what that phase has typically taken on this repository's recently merged tasks. `vinaya task status` renders one table for both its list and single-task forms; the `task_status` result carries the same facts as structured fields (`round`, `phase`, `minutesInPhase`, `phaseIsCurrent`, `lastConfidence`, `phaseHistory`), all optional, so a client written against the earlier shape still parses.

Typical times are history — a median with its sample count, computed from principal-authored round markers and verdict comments on recently merged task pull requests — never a prediction: a phase with too few past intervals, or a forge read that failed, shows no typical time rather than an invented one. The read is lazy, attempts the forge at most once per status read however many rows it lists, remembers a success for ten minutes and a failure only for a short back-off, and carries its own timeout, so a refusing forge is not asked again row after row.

Confidence distinguishes what the records distinguish: a round the loop asked whose statement was missing reads as an absence, a round it never asked reports nothing at all, and a figure read from the developer's own uncleared statement is marked as stated because its round's review has not completed.
