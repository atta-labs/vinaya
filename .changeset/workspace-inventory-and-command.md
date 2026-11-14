---
'@attalabs/test-selection': minor
'@attalabs/vinaya': patch
---

A repository with no inventory program of its own now gets its test plan from one call or one command. `workspaceInventory(repo, revision)` builds one commit's inventory view from the repository's own manifests, read only through the reader it is given: a suite for each workspace package, and for the root package, whose `test` script starts `bun test` or Vitest, and each test-named file as a test of the deepest package holding it. It also lists the packages it left out, with the reason (no `test` script, or another runner), and the test files outside every suite. The new `test-selection` command takes `--base` and `--head` commits, selects for the whole repository it is started in, and prints one JSON document: the planned tests, one group per runner start with its runner, working directory and file arguments, the fallback scopes and what the inventory left out. It starts no test and writes no file.
