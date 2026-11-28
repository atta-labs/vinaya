---
"@attalabs/vinaya": patch
---

The review-loop driver's push, check run and report refresh, and the evidence refresh, now start their commands through the same process guard the check runner uses, so one guard ends the processes a stopped driver's tools started. Exit status, output and clean-up of leftover processes are unchanged.
