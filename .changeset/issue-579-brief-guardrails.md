---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

`parseIssueTestPlan` now refuses a `## Test plan` fenced command line that runs a test runner with no test-file argument — a bare `bun test`, `bun test` on a directory, any `bunx turbo test` form, or `vitest run` on a package — naming the offending line, rather than freezing a brief whose own Part re-runs the whole suite the pre-push hook and CI already cover. A line naming specific `*.test.*`/`*.spec.*` file(s), or a `vinaya check` command, still passes. `assembleAndRenderBrief`/`assembleAndRenderBriefForIssue` now surface this refusal directly instead of silently falling back to an empty Test plan.

`vinaya dispatch`'s per-dispatch settings file now carries an `env` block (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, a raised `BASH_MAX_TIMEOUT_MS`) and a widened `PreToolUse` deny hook: a Bash call running a whole-suite test command, or a subagent call with its background flag set, is denied — so a dispatched session inherits this execution posture even with no operator export.
