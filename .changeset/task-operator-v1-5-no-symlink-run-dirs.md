---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Every writer that creates a run-file directory (the control store's own atomic writes, and `apps/cli`'s `ensureRunDir` — the one chokepoint every task-execution directory under a configured `runtimeDir` goes through) now refuses a pre-existing symlink, or a pre-existing real directory it cannot trust the owner or mode of, at any missing ancestor instead of silently writing through it. `mkdirNoSymlinks` (new, exported from `@attalabs/aeg-core`) creates each missing directory level individually and verifies it — never following a symlink, and, for a directory already there, refusing one owned by neither this process nor root, or one left world-writable with no sticky bit — before proceeding. A co-tenant on a shared, multi-account `runtimeDir` (the documented `/var/lib/vinaya/runs` shape) can no longer pre-plant a symlink, nor a real directory it owns or leaves open, to redirect a task's driver lock, ownership-epoch files, effects, resolutions, escalation records, or an unpublished reviewer's findings into a directory it controls.
