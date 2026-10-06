---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

The Developer now publishes, opens its pull request, reads it and runs checks only through tools the driver runs outside the agent's sandbox — never through a forge credential of its own.

The driver hosts a per-dispatch MCP server (`task-tools/dev-tools-host.ts`) in its own process, on a stable per-task unix socket, and registers it with each vendor through that vendor's own channel (Claude `--strict-mcp-config --mcp-config`, Codex a `[mcp_servers]` table with the approval key in the staged `config.toml`), so the worktree's committed `.mcp.json` is never loaded. It exposes six tools — `publish_changes`, `open_pull_request`, `update_pull_request_body`, `refresh_evidence`, `read_pull_request`, `run_checks` — each running in the driver behind the gates publishing already had (commit-header, publication-preconditions, protected-path, pre-push, PR-body) and returning a structured success or a structured refusal the agent acts on, never a loop pause. After a turn the driver no longer commits, pushes or opens anything itself: it detects work left unpublished and re-asks the same session once, naming `publish_changes`. `gh *` and `git push *` leave the Claude sandbox's excluded commands and the Developer role's permission allow-list, which now denies both families outright. The rendered brief, `loop.md` and `isolation.md` describe the tools-only model.
