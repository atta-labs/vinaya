---
"@attalabs/vinaya": patch
---

Doctrine now names the workflow that actually exists. `state-machine.md`'s per-task Archivist close-out row and `roles/archivist.md`'s automation-status paragraph both pointed at `.github/workflows/archivist.yml::post-merge`, a file that does not exist; the job lives in `vinaya-archivist.yml`. Both files ship in this package via `bundle-doctrine.ts` (`state-machine.md` in its `FILES` list, `roles/` in its `DIRS` list), so an adopter reading the shipped doctrine was being sent to a path they could not find in their own repo. The repo-root `verify-docs` script added alongside this is monorepo-local and does not ship.
