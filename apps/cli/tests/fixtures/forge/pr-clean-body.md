<!-- AEG:CLOSES:START -->
Closes #999
<!-- AEG:CLOSES:END -->

**For:** Sonnet (coding-agent CLI, dispatched locally)
**Project:** aeg-core

## Summary

A clean, single-paragraph summary.

## Technical surface map

- `packages/aeg-core/src/foo.ts`

## Pre-flight

```
git worktree add .worktrees/task/review-convergence-v1/999 -b task/review-convergence-v1/999 origin/main
```

## Test plan

```
bun test → passes
```

## Documentation-update list

- none

## Doc coverage

Doc-neutral: apps/cli/specs/self-hosting.md — this fixture exercises --validate-only against this repo's own live diff, which may carry a comment-only edit to apps/cli/src/lib/ops.ts.
Doc-neutral: apps/cli/specs/log.md — this fixture exercises --validate-only against this repo's own live diff, which may carry a comment-only edit to apps/cli/src/lib/log-sink.ts.
Doc-neutral: apps/cli/specs/loop.md — this fixture exercises --validate-only against this repo's own live diff, which may carry a comment-only edit to apps/cli/src/lib/dev-review-loop.ts.

## Stop conditions

- Pre-flight failure.

## Constraints

**Autonomy:** Do not stop to ask clarifying questions. For any ambiguity not
covered by a stop condition, choose the most reasonable option.

## Scope

One paragraph of blast radius.

<!-- AEG:TIER:START -->
**Tier:** 0
<!-- AEG:TIER:END -->
