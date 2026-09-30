---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The review-policy digest a verdict binds to now covers only the two settings that decide whether a verdict's findings block — `codeReviewThreshold` and `securityThreshold`. The loop's own limits, `maxRounds` and `maxTaskMinutes`, no longer feed `policyDigest`, so changing either one never re-opens an already-approved pull request.

The round cap and the wall-clock budget bound how long the loop runs; they cannot change whether a finding in an already-cast verdict blocks, so a verdict cast under one round cap or time budget stays bound after that limit changes. Changing either threshold still invalidates verdicts cast under the old one, exactly as before. This is a one-time digest move: any pull request with verdicts open when it merges needs one fresh review round.
