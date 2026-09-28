---
'@attalabs/vinaya': patch
---

The plan-time write gate (`vinaya issue create --validate-only`, `vinaya issue edit --validate-only`) now renders the brief with the SAME template dispatch resolves, in every repository, and at task creation — so an Issue that `vinaya task run` would refuse at brief render is refused when it is cut or edited, with the same message.

Two silent switch-offs are fixed. The gate resolved the brief template through `canRenderBriefFromHere()`, which required the workspace copy under `aeg-root/` that only Vinaya's own repository carries; an adopter that installs Vinaya from the registry has the packaged template dispatch renders from but no `aeg-root/` of its own, so the gate went dormant and printed "all brief-schema gates PASS" for a body dispatch then refused. It now checks the same packaged-first path the renderer reads. And a tranche task Issue is now rendered — as a draft, with a task id derived from its title — when it is CREATED, before it has an Issue number, not only when it is edited afterwards.

Checkout freshness stays a dispatch-time gate: the plan-time render skips the fast-forward/staleness checks, so a Planner may cut or edit Issues from a checkout that is behind the remote default branch. When the render genuinely cannot run (no template on disk, no resolvable owner/repo, not inside a git work tree, a create whose title yields no task id, or an edit whose Issue is not yet in the tranche's task list), the plan-time output now says so and why, rather than printing a pass for a render that never happened.
