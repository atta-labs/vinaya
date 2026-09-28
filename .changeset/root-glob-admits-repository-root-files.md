---
'@attalabs/aeg-core': patch
---

The root glob `*` in a `## Surface` now admits repository-root files such as `README.md` and `LICENSE`. `globCoversPath` covered a path only when the glob equalled it or one was a `/`-prefix of the other, so a bare `*` matched nothing real: no legal Surface glob admitted a repository-root file (a tracked path with no `/`). A Boundary pinning `README.md` could not pass `vinaya issue create --validate-only`, and `admittedSurfaceFiles` — which reads the same matcher — rendered an empty file list, so `vinaya brief render` produced no surface map. Observed live: a README task could not be validated and its author bypassed the CLI to open the Issue.

A bare `*` now covers every tracked path with no `/`, and only those. It never admits a nested path, so the common `in: *, out: apps` shape still excludes `apps/…`, and a `*` in an `out:` list excludes only root-level files. Only `*` is the root glob; `.` keeps its existing prefix behaviour unchanged, and every other glob matches exactly the files it matched before.
