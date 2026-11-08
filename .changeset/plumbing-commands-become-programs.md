---
'@attalabs/vinaya': minor
---

The command line keeps only the commands people type and the Planner's and Architect's commands. Every plumbing command is now a program of its own, shipped as an internal `bin` of the package and run as `npx --yes -p @attalabs/vinaya@<version> <bin>`:

- `check` → `vinaya-check`
- `commit-msg` → `vinaya-commit-msg`
- `waiver` → `vinaya-waiver`
- `archive`, `archive tranche`, `archive tranches` → `vinaya-archive`, `vinaya-archive tranche`, `vinaya-archive tranches`
- `pr create`, `pr edit` → `vinaya-pr create`, `vinaya-pr edit`
- `pr report` → `vinaya-pr-report`
- `pr verify-evidence` → `vinaya-pr-verify-evidence`
- `pr snapshot` → `vinaya-pr-snapshot`
- `tokens` → `vinaya-tokens`
- `review post` → `vinaya-review-post`
- `review status` → `vinaya-review-status`
- `dispatch` → `vinaya-dispatch`
- `dev-review-loop` → `vinaya-dev-review-loop`
- `task brief` → `vinaya-task-brief`
- `task sweep` → `vinaya-task-sweep`
- `task-tools serve` → `vinaya-task-tools-serve`
- `log send`, `log emit`, `log selftest` → `vinaya-log-send`, `vinaya-log-emit`, `vinaya-log-selftest`
- `sync` → `vinaya-sync`

`release` moved out of the package: this repository runs it as `bun scripts/release/release.ts`. `studio`, `new adr`, `task dispatch`, `demo break` and the `task-tools dev-proof`, `task-tools result-proof` and `task-tools review-result-proof` proofs are removed; `quickstart` still runs the refusal-then-fix proof `demo break` ran.

Run `vinaya upgrade` once to re-render the generated hooks and workflows, which now start these programs. A `VINAYA_TASK_RUN_COMMAND` launcher now receives the `vinaya-dev-review-loop` program's invocation for a resume with a pull request. Codex users re-add the `[mcp_servers.vinaya-task-tools]` table in `~/.codex/config.toml`: its command is now `npx --yes -p @attalabs/vinaya@<version> vinaya-task-tools-serve`.
