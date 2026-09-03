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
