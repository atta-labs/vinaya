---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

The driver now creates each task's own worktree, outside any sandbox, before the first Developer dispatch runs — the brief's own Step 0 only enters it, so a Developer dispatched on macOS under either vendor's own sandbox no longer has to run `git worktree add` from inside a confinement that denies writing the main checkout's `.git`. The confinement interface also grants both vendor adapters read-only access to the operator's own `~/.gitconfig` and `~/.config/git`, and on macOS puts the real git binary of the active developer directory ahead of the `/usr/bin/git` shim on `PATH`, so a plain `git` command resolves identity/aliases and never writes an `xcrun` cache outside the worktree.

`dev-review-loop/developer-dispatch.ts`'s `createTaskWorktree` replaces `createRemoteTaskBranch`: it creates `.worktrees/<branch>` (reusing one that already exists, never recreating it) and pushes the branch to the remote FROM that worktree with `-u`, never from the driver's own default-branch checkout, whose managed pre-push hook judges `main` itself against the task's own dispatch-readiness/test gate and refuses. `packages/aeg-core/src/brief-render.ts`'s rendered Step 0 is now `cd .worktrees/<branch> && bun install --frozen-lockfile --silent` — `brief-validation.ts`'s worktree-Step-0 checks accept either generation.

`worker-boundary.ts`'s `gitConfigReadOnlyPaths`/`resolveGitFirstPath` supply the new grants to both `buildClaudeSandboxSettings` (Claude's own native sandbox) and `resolveWorkerBoundaryLaunch` (Codex's Seatbelt boundary); `dispatch.ts` threads the resolved `PATH` into the confined child's env.

An agent's own configuration paths inside the worktree (`.claude/`, `.mcp.json` for Claude; `.codex/`, `.agents/` for Codex) now stay write-protected — Claude via a `write-access.mjs` hook carve-out, Codex via a Seatbelt deny layered after the worktree's own write grant — unless the task's own Surface `in:` globs name them, checked once per round from `dev-review-loop.ts`'s own Surface read.
