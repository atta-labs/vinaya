---
'@attalabs/vinaya': patch
---

A GitHub rate limit that ends a dev-review-loop round no longer pauses the loop asking for a Principal ruling: the loop reads the reset time once (`gh api rate_limit`, falling back to a few minutes for a secondary limit), waits, and re-enters the same round, spending no infrastructure retry. After two such waits with no round progress it pauses, and the pause comment names the rate limit and says a plain resume clears it.
