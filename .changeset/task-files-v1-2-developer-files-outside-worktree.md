---
"@attalabs/vinaya": patch
---

The Developer's confidence and round-response files now live under that round's own Developer folder inside the task's folder (`<runtimeDir>/tasks-execution/<task>/rounds/<n>/developer/`), never at the root of the Developer's worktree. The driver names the exact absolute path in that round's own prompt, fresh every round — a resumed Developer session never reuses an earlier round's path.

Before this, both files sat inside the Developer's git worktree, the one place agent scratch shares a tree with tracked source, where a stage-everything commit could add either one to the default branch (as happened once, live). Moving them out removes that exposure for every repository that adopts Vinaya, not only this one.

The driver's own unpushed-work check no longer exempts either file's old name: since neither is ever written to the worktree any more, a stray file bearing one of the old names is ordinary untracked work, visible like any other, never silently ignored.

Every confining dispatch — the `write-access.mjs` permission hook every Claude developer dispatch carries, and the macOS Seatbelt profile an isolation-required dispatch runs under — grants exactly these two files by exact path from outside the worktree, alongside the existing worktree directory grant; neither grant widens to the round's whole Developer folder.
