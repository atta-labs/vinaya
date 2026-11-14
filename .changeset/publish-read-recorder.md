---
'@attalabs/test-selection': minor
---

The package now ships the read recorder and its listing probe, with a `test-selection-record` command. On Linux with `strace`, the command runs each test file of the repository's inventory (built from its workspace manifests, as `test-selection` builds it) in its own traced process, with the probe preloaded in each Bun run, and writes `read-record.json`, the record `selectTests` takes as `records`. `--shard <i>/<n>` records one slice and `--merge <dir>` merges the slices; off Linux, or without `strace`, it exits 2 with one message. From code, `recordReads` and `recordCommand` take the inventory, runner launch, run-outcome check, time limit and dependency input as arguments, so a repository with its own inventory and runner reports records through the same code.
