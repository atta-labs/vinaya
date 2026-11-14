---
'@attalabs/test-selection': minor
---

The `test-selection` command takes two optional flags. `--record <file>` passes a read record a CI job produced to the selection, so a test with a valid record is decided by what it read. `--config <file>` reads a consumer config — a JSON document stating the import walk's depth, files a test reads without importing them and their readers, folder-scanning tests, programs tests start, data folders, always-run obligations and whole-suite policies — and selects with it. A missing or invalid record or config prints one message and exits 2, naming the offending key for a config. With neither flag the command prints the same plan as before.
