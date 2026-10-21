# harness/dev-process/engine-runtime

Runs a loaded process's Flow on Atta Engine. The process supplies an action registry (mechanical action name to in-process function), a decision registry (deciding step id to a boolean read from the examined result) and a role launcher built from the agent adapters' generated settings; a name the Flow uses that has no entry is refused before any step runs.
