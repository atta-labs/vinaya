# harness/dev-process/engine-runtime

Runs a loaded process's Flow on Atta Engine. The process supplies an action registry (mechanical action name to in-process function), a decision registry (deciding step id to a boolean read from the examined result) and a role launcher built from the agent adapters' generated settings; a name the Flow uses that has no entry is refused before any step runs.

## Checkpoints

`SqliteCheckpointer` (`sqlite-checkpointer.ts`) is the checkpoint saver a run keeps beside its other run files: one SQLite file opened with `bun:sqlite`, no added dependency. A runner process started later on the same file opens a new saver and `resumeProcessRun` continues from the last completed step; completed steps do not run again. Every checkpoint row records the code revision of the checkout that wrote it and the model the run was started with, and the saver reads both back for any checkpoint (`provenanceOf`) or a thread's latest one (`latestProvenance`). State a step carries to a later step (the round assessment's loop state, say) lives in that step's recorded result, so it is part of the checkpoint rather than held in memory.
