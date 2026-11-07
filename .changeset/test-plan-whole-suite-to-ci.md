---
'@attalabs/vinaya': patch
---

The ready push no longer runs a Test Plan command that runs a whole test suite (`turbo run test`, a bare `bun run test`, or `bun test` with no test files) locally: the required CI shards run every suite on the pull request, so the local run repeated that work and outlasted the per-command limit. Every other Test Plan command runs as before.
