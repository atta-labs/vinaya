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

Each workspace package that is a work surface gets its own row, so a task's
`Project:` names the package it actually touches rather than the repository
as a whole. `packages/typescript-config` has no row — shared tsconfig only,
never a work surface — and the `vinaya` row below is a repository root, not
a package, so this is the intent rather than a universal.

> **vinaya** — transitional. The original catch-all row, path `.`, from when
> this repo had one project. Measured with `projectsFromBody`
> (`packages/aeg-forge-state/src/list-tasks.ts:43`), the parser
> `checkProjectsRegistered` and the board derivation both call: of the 32 open
> task Issues, **31 declare `vinaya`** and **#104 declares no parseable
> `Project:` field at all** — it names the project only inside its
> `**Project(s) + blast radius**` prose, which that parser deliberately does
> not read. #104 therefore needs a field **added**, not remapped. The row is
> removed once both are settled; removing it while #104 still has no field
> would leave it resolving to no project, which is the fail-open the registry
> exists to prevent.

> **The `Specs` paths are declared, not yet real, and two questions ride on
> them.** Only `apps/cli/specs/` exists today. Both of the following are
> recorded here rather than settled, because both are Principal decisions:
> (1) `isSpecFile` (`packages/aeg-core/src/file-classify.ts:49`) matches
> `apps/**/specs/**` only, so a spec written at `packages/<name>/specs/` is
> classified as neither spec nor doc — invisible to `verify-docs` and to tier
> derivation, and routed to the `published` audience by
> `reader-resolvable-prose.ts`. (2) Five of the six rows name a directory that
> does not exist, so a Reviewer's spec-conformance check is vacuous for every
> project except `cli`. Nothing mechanical fails today — `specsPath` has no
> consumer outside `vinaya init product`'s row writer — but the first package
> spec written will hit (1) silently.

Registration is not cosmetic: a registered name clears
`checkBlastRadiusScope`'s multi-project bypass, so an Issue declaring two
registered projects no longer needs a `blast-radius-ack:` line. That check is
dormant in this repo regardless — it returns pass when `.aeg/packages` is
absent (`issue-validation.ts:322`), and `.aeg/` has no tracked files here — so
the effect is latent until that file exists.
