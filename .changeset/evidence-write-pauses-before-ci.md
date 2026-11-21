---
"@attalabs/vinaya": patch
---

A pull request whose Evidence block cannot be written now pauses the run for the infrastructure before its CI read, naming the pull request, the head and the reason, instead of sending the Developer back for a failure that is not in the code. A continued run writes the Evidence for the pull request that is already open and then reads CI.
