---
"@attalabs/vinaya": patch
---

Fix `vinaya upgrade` crashing (`ENOTDIR`) when run from inside a linked git worktree — it now resolves git-hook paths through `git rev-parse --git-common-dir`, the same fix `vinaya doctor` already had, lifted into a shared resolver both (and `init`, `quickstart`, `demo break`) now call.

Every AEG-style adopter that develops in linked worktrees hit this: a worktree's `.git` is a gitlink file, not a directory, so the old `join(repoRoot, '.git/hooks/…')` tried to `mkdir` under a file and aborted the whole upgrade before any other managed artifact (e.g. the doctrine pointer) was written. Hooks are never actually per-worktree — every linked worktree shares the primary checkout's hooks directory — so the fix resolves the real shared path instead of guessing wrong and crashing.
