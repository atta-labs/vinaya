---
"@attalabs/aeg-core": patch
---

From the second round on, the dev-review-loop's `gate_result_read` log event carries the developer's stated confidence at the point the loop reads it: the whole-number value and one-line reason as stated, or `confidence_unavailable: true` for a missing or malformed statement, plus `extra_turn_spent` telling a first statement apart from one made after the confidence rule's one extra developer turn. All four fields are optional, so a `gate_result_read` line logged before this change still parses. Round one and a red gate carry none of them, and the confidence rule itself is unchanged.
