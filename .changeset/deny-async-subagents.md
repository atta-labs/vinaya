---
"@attalabs/vinaya": patch
---

A dispatched role can no longer launch a subagent or workflow: Claude Code starts these in the background even when no background flag is sent, and the turn then ended with their edits unfinished. The hook now denies every Agent, Task and Workflow call under the background guard.
