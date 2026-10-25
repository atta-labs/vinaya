---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

An Engine run's checkpoints now record their format version and the Engine runtime version beside the code revision and model. A checkpoint that cannot be read, records neither version, or was written in another format or by an incompatible Engine runtime is refused before any step runs, as a new `checkpoint_refused` pause addressed to the Operator; resuming after only the code revision moved still continues. The Engine runner also pauses on an agent's usage limit and resumes by itself after the reset, within the same bound the standalone loop keeps, and the agents a killed runner left running are ended when the next runner starts.
