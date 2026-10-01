---
'@attalabs/vinaya': patch
---

On macOS the always-on worker sandbox now lets a dispatched role start the task-tools MCP server, and a round-1 resume failure no longer claims a round that never happened.

The rendered Seatbelt profile grants read AND exec (never write) on the real `node` install directory the task-tools MCP server starts, resolved fresh at launch via `which node` → `realpath` → `dirname` and added only when `node` exists — so a confined Claude/Codex session no longer crashes with `EPERM … posix_spawn 'node'` when the `node` on PATH symlinks into a Homebrew Cellar `bin/` (`/opt/homebrew/Cellar/node/<version>/bin`) or an nvm versioned `bin/` (`~/.nvm/versions/node/<version>/bin`), neither of which the existing `/opt/homebrew/bin`/`HOME` rules reach.

The dev-review-loop's resume-failure crash message no longer says a resume "failed this round … after succeeding last round" when the only earlier success was this same round's own fresh dispatch (round 1, where no previous round exists) — it now distinguishes a genuine previous-round success from a session whose first resume failed after its own fresh dispatch this round succeeded.
