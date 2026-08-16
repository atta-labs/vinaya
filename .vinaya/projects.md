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
| vinaya | `.` | `specs/` | (state tracked globally) |
