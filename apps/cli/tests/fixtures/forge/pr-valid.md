<!-- AEG:FOR:START -->
**For:** `Opus 4.8` (coding-agent CLI, interactive session)
<!-- AEG:FOR:END -->
<!-- AEG:PROJECT:START -->
**Project:** vinaya
<!-- AEG:PROJECT:END -->
<!-- AEG:TIER:START -->
**Tier:** 1
<!-- AEG:TIER:END -->

<!-- AEG:CLOSES:START -->
Closes #385
<!-- AEG:CLOSES:END -->

## Summary

Ships the validated forge-write path for the Vinaya CLI.

## Test Plan

```
bun test → passes
```
- [ ] **[principal]** Live-smoke a throwaway PR on the forge.

## Technical surface map

- apps/vinaya/cli/src/commands/pr.ts
- apps/vinaya/cli/src/lib/forge-write.ts

## Documentation-update list

- apps/vinaya/specs/vinaya-spec.md

## Doc coverage

Doc-neutral: apps/cli/specs/self-hosting.md — this fixture exercises the registered body checks against this repo's own live diff, which may carry a comment-only edit to apps/cli/src/lib/ops.ts.
Doc-neutral: apps/cli/specs/log.md — this fixture exercises the registered body checks against this repo's own live diff, which may carry a comment-only edit to apps/cli/src/lib/log-sink.ts.
Doc-neutral: apps/cli/specs/loop.md — this fixture exercises the registered body checks against this repo's own live diff, which may carry a comment-only edit to apps/cli/src/lib/dev-review-loop.ts.

## Stop conditions

- Any pre-flight failure halts the task.

## Autonomy

Do not stop to ask clarifying questions; choose the most reasonable option and record it.

## Pre-flight

```
git worktree add .worktrees/task/vinaya-cli-v1/5 -b task/vinaya-cli-v1/5 origin/main
```
