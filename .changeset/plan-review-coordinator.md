---
"@attalabs/vinaya": patch
---

The Planner can start, read and limit independent review rounds of a stored plan draft. `plan_review_start` runs one fresh read-only round only on a draft checked as a whole at its current fingerprint, validates the answer, derives the verdict and stores the round with the draft; `plan_review_status` reads the rounds, the findings (open, resolved or a note) and whether the current fingerprint is approved; `plan_review_decide` records the Principal's choice to allow one more round or stop the plan once the round limit is reached. A changed draft never inherits an earlier approval, a later round judges only what is left to judge, and the count of rounds spent is kept with the draft across revisions and new chats. Two settings, `planning.reviewRoundLimit` (two by default) and `planning.reviewAgent` (`same` by default, or `different`), are documented in the configuration reference.
