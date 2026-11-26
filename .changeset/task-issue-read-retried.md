---
"@attalabs/vinaya": patch
---

The dispatch gate scripts retry a failed read of the task's Issue after a connection failure, and a read that still fails blocks as `issue-read-failed` with the forge's own error, never as a missing Issue.
