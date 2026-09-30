---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

Every task's review loop now ends within a known amount of WORK, not only a known number of rounds. `reviewPolicy.maxTaskMinutes` (default 180, `0` turns it off) bounds the time a task spends in its active phases; over budget is `pause{reason:'time_budget'}`, and the pause names the budget, the active minutes actually spent, and where they went phase by phase — `task time budget: 180 min, spent 214 min — developing 190 min, reviewing 24 min`.

This bounds what the round cap cannot. The round number advances only when verdicts come back, so a loop spending its hours pushing, rebasing, waiting on checks and retrying approaches no cap at all; runs of six hours, and push attempts of over an hour, happened that way with every existing bound intact.

The budget counts only the phases a driver is working the task forward — developing (which spans the push and the gate wait after it, and the mechanical retries recorded under the same phase), reviewing, and awaiting the developer's confidence. Time the task sat `paused` waiting for a Principal, time it spent `publishing` an already-approved pull request, and any stretch with no driver running at all never count: the clock is the sum of the loop's own recorded active-phase times (`phaseMs`, carried across restarts), not the wall-clock age since the task first started. So a task first started days ago is bounded by the minutes it has actually worked — an approved pull request resumed only to re-cast a verdict is never paused for the hours it sat waiting.

The budget is checked at every round boundary and every mechanical retry, so a phase stuck short of review cannot run past it by more than the one attempt in flight when it ran out. It is deliberately not checked once a round's verdicts are back: reviewers have already done that round's work, so their verdicts still decide it and the loop stops at the boundary that follows. `maxTaskMinutes` joins the review-policy digest, so a verdict cast before this change needs one fresh review round.
