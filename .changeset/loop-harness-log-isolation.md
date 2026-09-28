---
"@attalabs/vinaya": patch
---

The in-process dev-review-loop test harness now runs against an isolated log configuration of its own, so a loop test run can no longer resolve the repository's configured `logs.url` server and deliver fake review-loop events to it. The harness reuses `isolatedConfigFixture` (a working directory declaring its own `logs.folder`, plus an isolated `$HOME`/`AEG_REPO`), which makes the trust-anchor resolution refuse the default branch's server and fall back to a per-run folder. Test-only change; real loop runs still deliver to the configured destination unchanged.
