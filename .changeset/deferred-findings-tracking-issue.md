---
'@attalabs/vinaya': patch
---

Findings the dev-review loop sets aside rather than let block — those outside the task's Surface, or on a line the round did not change — are now tracked in one backlog Issue per pull request, so they are not lost once the loop closes. A publication that carries deferred findings opens or updates that Issue, listing each finding's round, severity, `file:line` and the reason it was deferred, and links it from the published summary; a publication that deferred nothing opens nothing.

The Issue is found by a hidden marker naming the pull request (never by title), so a second publication of the same pull request updates the same Issue instead of opening another. It carries a fixed `vinaya/deferred` label and no tranche label, so no plan gate applies to it and it never reads as a planned task.
