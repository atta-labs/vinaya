---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

Every task's review loop now ends within a known time, not only a known number of rounds. `reviewPolicy.maxTaskMinutes` (default 180, `0` turns it off) bounds one task's total wall-clock time; over budget is `pause{reason:'time_budget'}`, and the pause names the budget, the minutes actually spent, and where they went phase by phase — `task time budget: 180 min, spent 214 min — developing 190 min, reviewing 24 min`.

This bounds what the round cap cannot. The round number advances only when verdicts come back, so a loop spending its hours pushing, rebasing, waiting on checks and retrying approaches no cap at all; runs of six hours, and push attempts of over an hour, happened that way with every existing bound intact.

The clock starts at the loop's first recorded start for the task, not at the current driver's own start, so a driver that was killed, taken over, or re-execed itself continues the same budget rather than beginning a fresh one: the `loop_state` record now carries `taskStartedAt` (written once, carried forward unchanged) and `phaseMs` (accumulated across restarts), and falls back to the earliest ownership epoch's `acquiredAt` — created with `O_EXCL` and never overwritten — for a task recorded before those fields existed.

The budget is checked at every round boundary and every mechanical retry, so a phase stuck short of review cannot run past it by more than the one attempt in flight when it ran out. It is deliberately not checked once a round's verdicts are back: reviewers have already done that round's work, so their verdicts still decide it and the loop stops at the boundary that follows. `maxTaskMinutes` joins the review-policy digest, so a verdict cast before this change needs one fresh review round.
