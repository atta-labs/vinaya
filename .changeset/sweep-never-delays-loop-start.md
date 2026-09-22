---
"@attalabs/vinaya": patch
---

The dev-review loop's start-of-run sweep no longer runs synchronously ahead of the run's own narration and its first dispatch. The run-start marker and a `sweep — running` line now land in the loop log and on stderr before the sweep's own forge lookups begin; the sweep itself is started, never awaited, so the first developer dispatch of a run never waits on it, however many finished task folders there are to classify. Each folder's own decision now prints as it is made, with a running count, instead of arriving as one block after every lookup finishes.

The sweep's decisions are unchanged: the same folders are removed and kept for the same reasons, and unreadable forge state still keeps a folder rather than guessing. A folder found finished is now classified a second time, immediately before it is removed, so a task revived in the meantime (its Issue reopened, its pull request moved) is never deleted on a stale answer. `vinaya task sweep` on demand is unaffected.
