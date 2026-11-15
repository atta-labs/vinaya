---
'@attalabs/vinaya': patch
---

The index-outage test is on the outside-call list. It reads its token with `gh auth token` when neither `GITHUB_TOKEN` nor `GH_TOKEN` is set, so a review round with no token variable ran it against the stand-in and failed it; the list had been measured with a token variable set.
