---
'@attalabs/vinaya': patch
---

An unattended Claude dispatch is no longer wrapped in a hand-built Seatbelt profile — it now runs inside Claude Code's own sandbox, which needs nothing installed, so Developer and Reviewer dispatches on macOS work again rather than failing on `git`'s own developer shim, `~/.gitconfig`, the system certificate store, turbo's and bun's home folders, and the log path.

`worker-boundary.ts` gains a provider-neutral confinement interface (`ConfinementRequest`/`resolveClaudeConfinement`) that takes a role, its task worktree, its scratch directory and the hosts it may reach, and returns Claude's own sandbox settings — `enabled`, `failIfUnavailable` and `allowUnsandboxedCommands: false`, filesystem writes scoped to the worktree and scratch directory, reads denied in the real home outside them, and network limited to GitHub and the npm registry. `dispatch.ts` calls it once for every unattended Claude dispatch instead of wrapping the whole process in the old hand-built profile, which is no longer applied to Claude at all (Codex's own Seatbelt boundary is unchanged). On macOS this sandbox is always on; on Linux it activates when the host has `bubblewrap` and `socat`, and otherwise the dispatch still runs, unconfined, with a warning naming the missing tool in the run's own output and the Vinaya Log — nobody is ever required to install anything.
