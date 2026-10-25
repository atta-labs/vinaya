---
"@attalabs/vinaya": patch
"@attalabs/aeg-types": patch
---

A Developer push fits the publish tool's time limit on both runners. The pre-push hook's selection for a change to the repository-root `vinaya.config.json` now adds only the CLI tests that import the configuration loader directly, plus `prePush.alwaysRun`; a pull request's CI selection still runs the whole CLI suite for it. The Engine runner's Codex and Claude Code Developer configs give the dev-tools server the same thirty-minute per-call limit as the standalone loop, read from the new `@attalabs/aeg-types/dev-tools` export.
