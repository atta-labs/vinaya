---
'@attalabs/vinaya': patch
---

The log sink caches the default-branch config per repository, so no test has to reset it between files.

The trust-anchor read that decides an unattended run's whole log destination (`processTrustAnchor`, `log-sink.ts`) was memoised in a single process-wide slot with no key. A process that logs from two repositories — a `bun:test` runner loading many files, each driving its own fixture repository — filled the slot from the first file's checkout, and every later file was served that checkout's `logs.url` server instead of reading its own repository's config: a fixture whose configuration declares no `logs` setting delivered to the real server and read its own folder back empty. The guard was a teardown call, `resetTrustAnchorConfigMemo()`, held by nothing (CI runs without the unattended classification and shards the two files apart, so deleting it stayed green in CI and red only on a developer's push).

The cache is now keyed by the resolved repository root (`processTrustAnchorByRepo`): each repository reads its config exactly once and never serves it to another, and a directory in no git repository keys one shared `null` slot where the read answers nothing regardless. `resetTrustAnchorConfigMemo()` stays exported and clears every entry for a test that wants a clean slate, but nothing depends on calling it.
