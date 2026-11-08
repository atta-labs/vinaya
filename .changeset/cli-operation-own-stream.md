---
'@attalabs/vinaya': patch
---

A `vinaya` command or a check run on the same machine as a test run no longer turns that run red. The operation event every command records as it exits now lands in its own file, `none-cli-operations.ndjson`, and a check run's gate events that name no task land in `none-gates.ndjson`, both beside the shared `none.ndjson`; the test run's check for writes into the real runtime folder exempts those two files and still reports every other file. `vinaya log send` delivers both files as it delivers `none.ndjson`.
