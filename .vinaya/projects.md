---
sidebar_title: Projects
---
# Projects in this repo

**The project registry.** Declares the projects in this repo and where each
one's specs and per-project state live. The `Project` field on a task (a
forge Issue) resolves against this file.

**Presence of this file means this is a multi-project repo** — the
`Project` field is required on task Issues/PRs that touch a registered
project's path. A project is a `(name, path)` pair you declared — nothing
is derived from the folder tree.

## Registry

| Project | Path | Specs | Per-project state |
|---------|------|-------|---------------------|
| cli | `apps/cli` | `apps/cli/specs/` | (state tracked globally for now) |
| log-server | `apps/log-server` | `apps/log-server/specs/` | (state tracked globally for now) |
| aeg-core | `packages/aeg-core` | `packages/aeg-core/specs/` | (state tracked globally for now) |
| aeg-forge-state | `packages/aeg-forge-state` | `packages/aeg-forge-state/specs/` | (state tracked globally for now) |
| aeg-types | `packages/aeg-types` | `packages/aeg-types/specs/` | (state tracked globally for now) |
| sources | `packages/sources` | `packages/sources/specs/` | (state tracked globally for now) |
| vinaya | `.` | `specs/` | (state tracked globally) |

Each workspace package that is a work surface gets its own row, so a task's
`Project:` names the package it actually touches rather than the repository
as a whole. `packages/typescript-config` has no row — shared tsconfig only,
never a work surface — and the `vinaya` row is a repository root, not a
package, so this is the intent rather than a universal.

> **vinaya** — transitional, from when this repo had one project. It is
> removed once every open task Issue declares a real project. #104 needs a
> `Project:` field **added**, not remapped: it names its project only inside
> its `**Project(s) + blast radius**` heading, which `projectsFromBody`
> (`packages/aeg-forge-state/src/list-tasks.ts:43`) deliberately does not
> read, so a remap-only pass would leave it resolving to nothing.

> **The `Specs` paths are declared, not yet real** — only `apps/cli/specs/`
> exists. Where a package's specs belong is unsettled: `isSpecFile`
> (`packages/aeg-core/src/file-classify.ts:50`) and `isDocFile` (`:35`) both
> match `apps/**/specs/**` only, so a spec at `packages/<name>/specs/` is
> invisible to `verify-docs` and to tier derivation
> (`packages/aeg-core/src/pr-tier.ts:24`). Nothing reads `specsPath` today
> outside `vinaya init product`'s row writer. `isDocFile` also now
> recognizes a package-level `apps/<name>/README.md` / `packages/<name>/README.md`
> (`:36`), independent of this unsettled `specsPath` question.
