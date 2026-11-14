---
'@attalabs/test-selection': minor
---

The read recorder now writes a version-2 record. For each file a test read, it stores how many times the test's own process opened it successfully (its threads count as part of that process) in `opens`, and in `childOpens` it lists the files a child process opened. For a Bun run it also stores Bun's line coverage in `coverage`: for each source file the lcov report lists, the lines Bun instrumented and the lines the test executed, both as line ranges. A Vitest run's entry has no coverage, which means the coverage is unknown.

The trace now also follows `chdir` and `fchdir`, and a thread's change of folder applies to its whole process. An open counts only when its result is a file descriptor, including a result printed on a `<... resumed>` line. Every read, failed lookup and listed folder a version-1 record held is still recorded.

`isReadRecord` accepts versions 1 and 2 and refuses any other version. A merge refuses shards that wrote different versions. Selection does not read the new fields yet, so a version-1 record selects the same tests as before. New exports: `READ_RECORD_VERSION`, `ReadRecordVersion`, `FileCoverage`, `LineSpan`, `lineSpans`, `fileCoverage`, `coverageOfLcov`, `coverageOfRun`, `withCoverage` and `LCOV_FILE`.
