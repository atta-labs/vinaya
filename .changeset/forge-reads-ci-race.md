---
'@attalabs/vinaya': patch
'@attalabs/aeg-forge-state': patch
---

The dispatch checks read the forge in bounded time. Every `#NNN` Depends-on or Conflicts-with edge is read at the same time as the others instead of one after another, with unchanged verdicts. The prior-tranche archival resolution takes each candidate tranche's tasks and open Issues from the Issue lists the Milestone index already read, so no tranche label is listed twice in one run; the index now returns those lists per slug. A failed edge read or index read is made once more before it counts: a read that fails twice still blocks as an unread dependency or a `severity:infra` failure, and an Issue the forge says does not exist is never read again. The version-2 strict CI read no longer sends a fully green run back: a required check that completed `success` while its run is still finishing reads pending until the run completes.
