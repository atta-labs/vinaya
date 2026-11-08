---
'@attalabs/vinaya': patch
---

A `task run` on an Engine-runner task whose held pause was cancelled refuses, before assigning the Issue or starting the Engine, while the cancelled run's checkpoint is still in place, and names the `task switch` command that sets it aside and starts the task anew. Once a `switched-*` folder is stamped after the cancel, or when the task has no checkpoint file, the run starts as it does for any task with none.
