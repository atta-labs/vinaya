---
'@attalabs/vinaya': patch
---

The evaluation harness stages every trial in an isolated, non-local clone holding only the base commit's history and one task branch, or in a snapshot with no git metadata, and refuses to start it unless a contamination test passes: the clone's complete object set equals an allowed-object manifest frozen from the base commit beforehand, an integrity check finds no unreachable object, no ref but the task branch exists, no reflog holds an entry, no alternates, promisor, graft, shallow boundary or remote is configured, every agent state directory is new and empty, and no hidden test or reference solution is visible. After the trial, every created object is attributed to it, and hidden inputs are applied only in a separate grading copy. The harness is internal and does not ship.
