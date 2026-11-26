---
"@attalabs/test-selection": patch
---

A process builds the compiler graph once per set of inputs: a repeated selection over the same files, manifests, entrypoints, compiler and workspace links reuses the graph and reports a program time of 0, and any change to one of them builds it again. `GraphInput` gains an optional `workspaceKey`; a direct caller of `buildCompilerGraph` that omits it still builds afresh on every call.
