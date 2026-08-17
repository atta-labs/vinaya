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
| aeg-core | `packages/aeg-core` | `packages/aeg-core/specs/` | (state tracked globally for now) |
| aeg-forge-state | `packages/aeg-forge-state` | `packages/aeg-forge-state/specs/` | (state tracked globally for now) |
| aeg-types | `packages/aeg-types` | `packages/aeg-types/specs/` | (state tracked globally for now) |
| sources | `packages/sources` | `packages/sources/specs/` | (state tracked globally for now) |
| vinaya | `.` | `specs/` | (state tracked globally) |

Each workspace package is its own project: a package is a real collision
domain with its own code, so a task's `Project:` names the package it
actually touches rather than the repository as a whole.

> **vinaya** — transitional. The original catch-all row, path `.`, from when
> this repo had one project. Every open task Issue still declares it; the row
> is removed once each has been remapped to the package it really touches.
> `packages/typescript-config` has no row: shared tsconfig only, no task has
> ever touched it as a work surface.
