---
"@attalabs/vinaya": patch
---

A review round run on the Engine now starts one git process for each local read of a ref or merge base (a worktree head, a merge base, a local ref) between two changes to the repository, instead of one per read: the answers are kept only while a driver step runs, never while an agent turn or a Developer tool call is in flight, and are dropped at each step boundary, after every write the loop makes and after every child process a step starts. A run also asks the remote for the default branch's name once, while the default branch's head is still read fresh each time. The standalone runner reads git as before.
