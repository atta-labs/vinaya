---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Every writer that creates a run-file directory (the control store's own atomic writes, and `apps/cli`'s `ensureRunDir` — the one chokepoint every task-execution directory under a configured `runtimeDir` goes through) now refuses a pre-existing symlink at any missing ancestor instead of silently following it. `mkdirNoSymlinks` (new, exported from `@attalabs/aeg-core`) creates each missing directory level individually and verifies it without following symlinks before proceeding, so a co-tenant on a shared, multi-account `runtimeDir` (the documented `/var/lib/vinaya/runs` shape) can no longer pre-plant a symlink to redirect a task's driver lock, ownership-epoch files, effects, resolutions, escalation records, or an unpublished reviewer's findings into a directory they own.
