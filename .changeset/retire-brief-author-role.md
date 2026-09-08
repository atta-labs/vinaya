---
"@attalabs/aeg-core": minor
"@attalabs/aeg-forge-state": patch
"@attalabs/aeg-types": patch
"@attalabs/vinaya": minor
---

The Brief Author role is retired: the brief is dispatched by the Planner, not authored by a separate role. `author-the-brief` (`ACTIONS`) is now `performedBy: ['planner']`. The `needs-brief-correction` label keeps its id — Issues in flight carry it — but its copy now names the Planner. `vinaya doctrine --role brief-author` refuses, pointing the caller at `--role planner`, even while `aeg-root/roles/brief-author.md` still exists on disk. `vinaya upgrade` (and `eject`) now remove a generated `.agents/skills/vinaya-<role>/SKILL.md` whose role no longer resolves under the doctrine root, closing the same gap for any future role retirement.

`AEG_BRIEF_V1_MARKER` and `contentAfterTwoLines` are promoted into `@attalabs/aeg-core`'s exports — the single implementation `packages/aeg-core/bin/verify-brief.ts`, `verify-dispatch.ts`, `archive-task.ts` and `apps/cli`'s `dispatch-task.ts`/`check-brief-shape.ts` all now share, replacing four independent copies. `verify-brief.ts` now grades the task Issue's frozen `aeg:brief:v1` comment on a task branch — the same body `vinaya check brief-shape` already grades since the brief was moved off the PR body — instead of `PR_BODY`, so the authoring-time gate and the CI gate cannot disagree about a post-split brief.
