---
"@attalabs/aeg-core": minor
"@attalabs/aeg-forge-state": patch
"@attalabs/aeg-types": patch
"@attalabs/vinaya": minor
---

The Brief Author role is retired: the brief is dispatched by the Planner, not authored by a separate role. `author-the-brief` (`ACTIONS`) is now `performedBy: ['planner']`. The `needs-brief-correction` label keeps its id — Issues in flight carry it — but its copy now names the Planner. `vinaya doctrine --role brief-author` refuses, pointing the caller at `--role planner`, even while `aeg-root/roles/brief-author.md` still exists on disk. `vinaya upgrade` now removes a generated `.agents/skills/vinaya-<role>/SKILL.md` for a role this codebase has retired, and no longer generates one. Retirement is DECLARED (`RETIRED_ROLE_NAMES`), never inferred from a role file's absence — `aeg-root/roles/brief-author.md` deliberately outlives this change, so an emitter that read the file as proof of liveness would both skip the cleanup and keep writing a skill whose embedded `vinaya doctrine --role brief-author` this same release refuses. `eject` is unchanged.

`AEG_BRIEF_V1_MARKER` and `contentAfterTwoLines` are promoted into `@attalabs/aeg-core`'s exports — the single implementation `packages/aeg-core/bin/verify-brief.ts`, `verify-dispatch.ts`, `archive-task.ts` and `apps/cli`'s `dispatch-task.ts`/`check-brief-shape.ts` all now share, replacing four independent copies. `brief-author` is removed from `@attalabs/aeg-core`'s `ROLE_VALUES`, the log schema's dispatchable-role union, so a log line claiming that role no longer validates. `verify-brief.ts` now grades the task Issue's frozen `aeg:brief:v1` comment on a task branch — the same body `vinaya check brief-shape` already grades since the brief was moved off the PR body — instead of `PR_BODY`, so the authoring-time gate and the CI gate cannot disagree about a post-split brief.
