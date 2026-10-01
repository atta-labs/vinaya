---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

The review loop no longer posts a round table on the pull request; each round's findings, outcome and confidence are recorded only in the Vinaya Log.

Publication now posts one comment whose content is a single hidden line, `<!-- aeg:loop:published head=<sha> confidence=1:-,2:80 -->`, followed by a link to the deferred-findings Issue only when one was opened or updated. The loop reads that marker, from principal-authored comments only, to know a review already published and to report each round's confidence in `task_status`. Rounds rebuilt after a restart no longer show "—" in a second, weaker copy of the Log. `task_pr_read` no longer returns a `summaryTable` field.
