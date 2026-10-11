---
'@attalabs/vinaya': patch
---

A reviewer writing inside its own scratch copy of the candidate no longer trips the after-turn confinement check; the shared candidate and other rounds' folders stay protected. When one reviewer's turn pauses the round, the loop now waits for the other reviewer, keeps its verdict on disk, and the automatic infrastructure resume reviews the same head again instead of handing the Developer a turn with no findings.
