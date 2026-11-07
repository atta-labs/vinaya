---
'@attalabs/vinaya': patch
---

A push and CI run exactly the tests a change can break, from each test file's recorded reads. A recorder job on the default branch runs every test file under `strace` and stores the paths each one opened, probed or listed as an artifact named for the commit; a selection decides each test file with a valid record by that record and keeps the static selection, unchanged, for a test with no record, a record whose paths changed, a platform branch off Linux or a `.git/` read, naming each. A local push and CI call the same selection, and a test that passed earlier on a branch is kept per test, with the head that proved it, instead of re-running when only the verification context moved.
