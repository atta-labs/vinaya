---
"@attalabs/vinaya": patch
---

The control store holds one lock per task across each ownership claim, across each fenced write's ownership check and its write, and across the read and write that mark a started effect uncertain. A write made under an ownership number a newer claim has superseded is now refused even when that claim arrives between the write's check and the write itself, and a verified effect is never overwritten as uncertain. The lock is a `task.lock` file in the task's control folder naming its holder's process id and host: a lock whose holder no longer runs is taken over by exactly one waiter, and a lock a live process holds for more than ten seconds makes the waiting call throw `TaskLockTimeoutError` with nothing written. No record, record path or exported signature changes.
