---
'@attalabs/vinaya': patch
---

Close the remaining gaps a live `task run` of each confined agent found after the sandboxes moved to each vendor's documented model.

Every Claude Code Developer dispatch prompt now states the bare-forge-command rule: each `gh`, `git push`, `git pull` and `git fetch` must run as its own Bash command with nothing chained before or after it, because only a line that matches one of `CLAUDE_SANDBOX_EXCLUDED_COMMANDS` on its own runs outside the sandbox with the forge credential — a chained one runs inside, where the credential is denied and it fails. `bareForgeCommandRule` returns that line for Claude and nothing for Codex (whose driver publishes for it).

The sandbox conformance suite now launches a Developer's commands the way Claude Code does: `claudeRunsCommandUnsandboxed` decides, by a whole-line match against the excluded patterns (never a shell-text parser), whether a line runs outside the sandbox. A bare `gh issue view`/`git push` runs outside and exits 0; a chained `gh` line stays inside and is recorded as the one Claude/darwin known failure. The suite also translates the driver's `sandbox.credentials.files` deny-list into the raw runtime's `filesystem.denyRead`, so the gh token store is really denied inside. The three bare-`gh` Claude/darwin known failures and both Claude/linux known failures (`typecheck`, `check-all`) are removed.

A confined Codex Developer can now read an official documentation page its web search found: `buildCodexSandboxConfigToml` names the vendors' own documentation hosts (`DOCUMENTATION_HOSTS`: `developers.openai.com`, `platform.openai.com`, `docs.anthropic.com`, `code.claude.com`) in `features.network_proxy.domains`, one by one, alongside the GitHub/npm hosts — never a broad documentation allowance.

A Vinaya CLI command run inside either agent's sandbox now records its log events instead of printing "log outbox target could not be opened", without granting the agent write access to the operator's log directories: the driver stages a spool directory inside the dispatch's own granted scratch (`VINAYA_LOG_SPOOL_DIR`), the confined child's `log()` appends there, and the driver delivers the spooled events to the real log folder after the turn, outside the sandbox (`drainLogSpool`).

`apps/cli/specs/isolation.md` and `apps/cli/specs/log.md` describe each of these behaviours. One gap is not closed and is escalated on the task Issue (`severity:strategy`): `check --all` inside Claude's sandbox on macOS still cannot authenticate to the forge (no token in the environment, `~/.config/gh/hosts.yml` denied), and staging the CLI's own forge reads from outside without a token needs a forge-facts staging subsystem whose natural seam (`createForgeSource`) is out of this task's surface.
