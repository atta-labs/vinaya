---
'@attalabs/vinaya': minor
---

The version 2 ready push runs its tests as a cancellable, contained child with a 20-minute deadline; the generated pre-push hook runs an adopter's declared test runner (`.vinaya/test-runner`) on the ready push, or reports that the repository runs no local tests.
