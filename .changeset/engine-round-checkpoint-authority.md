---
'@attalabs/vinaya': patch
---

An Engine run's execution round is now held in its checkpoint: the step that ends a round records the round it leaves the run in, and a restarted runner continues in that round instead of starting again at 1, so its next push is never refused as a replayed input version. A runner that stopped after a step's writes were stored but before the next checkpoint was saved now resumes after that step instead of refusing the run as finished. The round is mirrored into the control store after each committed write, and a failed mirror write pauses the run before its next step without repeating the step it follows. Every checkpoint also records the agent its run was started with.
