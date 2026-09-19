---
"@attalabs/vinaya": patch
---

The monorepo `test` task is never cached (`turbo.json`'s `tasks.test.cache: false`), so no caller of `turbo test` on this repository — present or future — can ever replay a stale pass instead of genuinely re-running.

`vinaya.config.json`'s `prePush.alwaysRun` now names `apps/cli/tests/lib/log-callers.test.ts` — a repo-wide invariant test the file-level pre-push selector's import-graph reachability can never reach on its own, since it walks the whole source tree rather than importing the files it checks. Two real pushes passed the hook and failed CI on exactly this gap.

The dev-review-loop test suite's subprocess fixtures no longer inherit this process's own `VINAYA_*` environment (most importantly `VINAYA_RUNTIME_DIR`) into the driver subprocess they spawn — a dispatched session's own environment previously redirected every fixture's driver to this machine's real, shared runtime directory regardless of the fixture's own isolated `$HOME`, racing its driver lock and control-store files against every other concurrent task run. Each fixture's subprocess is now also bounded by an explicit, generous budget that fails with the child's own captured stdout/stderr on expiry, rather than a bare test-framework timeout.
