---
'@attalabs/vinaya': patch
---

A review round now runs its selected tests beside both reviewers. A red test ends the round as changes requested even when both reviewers approved: the Developer is sent back with one blocking finding naming the first failing test and its file and line, and its prompt carries the failure output. Passed, none, timed out and unavailable results leave the round as it was.
