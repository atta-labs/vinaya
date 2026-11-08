---
'@attalabs/vinaya': patch
---

A `vinaya` command run on the same machine as a test run no longer turns that run red. The operation event every command records as it exits now lands in its own file, `none-cli-operations.ndjson`, beside the shared `none.ndjson`; the test run's check for writes into the real runtime folder exempts that one file and still reports every other file. `vinaya log send` delivers the new file as it delivers `none.ndjson`.
