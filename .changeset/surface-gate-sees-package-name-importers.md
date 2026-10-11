---
'@attalabs/vinaya': patch
---

The Surface gate sees a pinned module's callers that import it through a workspace package name. The pinned-file importer listing now also counts a tracked file that imports, from a workspace package's name, a binding the pinned module exports and the package's index re-exports; a file importing only other bindings of that package is not an importer. `vinaya issue surface`, `issue create` and `issue edit` read the same listing, so the report and the gate agree.
