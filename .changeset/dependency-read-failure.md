---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The dispatch readiness check no longer reports a dependency as "not merged" when the forge could not be read: it now refuses with its own retryable reason (a distinct "forge could not be read" message). A backlog dependency's pull request is read for that Issue directly instead of from the newest 300 pull requests, so a dependency merged long ago is recognized as merged.
