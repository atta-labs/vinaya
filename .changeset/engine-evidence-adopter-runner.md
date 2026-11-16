---
'@attalabs/vinaya': patch
---

An Engine run in a repository whose pre-push hook runs its declared test runner (`.vinaya/test-runner`) now writes Evidence that matches its Test Plan: the Test Plan's test line becomes `.vinaya/test-runner → every test passes`, the Group C entry for it is the hook's recorded run under that same command, and every other Test Plan command keeps its receipt, so `evidence-fresh` passes instead of refusing a Group C headed `repository pre-push hook`.
