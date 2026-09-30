---
'@attalabs/vinaya': patch
---

A `--agent codex` dispatch now refuses the same machine-changing commands a Claude Code dispatch refuses. The machine-state deny floor (`security` and every subcommand, `launchctl`, `defaults`, `systemsetup`, `networksetup`, `pmset`, `dscl`, `crontab`, `chsh`, `sudo`, and `git config` at `--global` or `--system` scope) was written only into the Claude settings file; a Codex run of the same role got no command policy at all, so the incident it answers — a dispatched role replacing the machine's default keychain — was equally possible through Codex.

Codex has no `permissions.deny` list. Its per-run command policy is an execpolicy `.rules` file — `prefix_rule(pattern = [...], decision = "forbidden")` — which Codex discovers from `<CODEX_HOME>/rules/*.rules` at startup. The same list is translated into that grammar (read back out of the Claude-side deny policy, never kept as a second copy) and staged into the run's own `CODEX_HOME/rules/`, never the operator's `~/.codex`. Repository-scoped `git config`, which a dispatched developer's own first step runs, stays runnable, as do the version-control, forge and test commands doctrine names.

The mechanism and syntax were established live against the installed `codex-cli 0.152.1` with its own dry-run checker: `codex execpolicy check --rules <file> security default-keychain -s …` returns `"decision":"forbidden"`, while `git config push.autoSetupRemote true` returns no forbidding rule. The policy carries the same `v3` version string the Claude side carries, and a Codex run of a floor-carrying role now names that policy in its first lifecycle line instead of the former `NO permission policy` notice.

This is a floor, not a sandbox: Codex's prefix match, like the host's own `Bash(<command>:*)` grammar, catches a named command but not the same command reached under a wrapper word, through another interpreter, or inside a script the session wrote and then runs. Confining those is the worker isolation boundary's job.
