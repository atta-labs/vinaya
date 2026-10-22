# harness/adapters/agents

Adapters for coding agents. Belongs to the "Any Process, One Harness" project.

## The capability contract

A role's `grants.yaml` declares what the role may do. It never names a vendor's tools; each adapter maps the declaration to its own built-ins. The schema is `RoleContract` in `manifest.ts`:

```yaml
role: developer | code-reviewer | security-reviewer
models: { claude: <id>, codex: <id> }     # the one per-vendor field: a model id names one vendor's model
capabilities:
  read_files: allow | deny
  run_commands: deny | { default?: allow, allow: [<prefix>…], deny: [<prefix>…] }
  write_files: deny | [<root>…]           # ${WORKTREE}-style placeholders allowed
  network: [<domain>…]
  web_fetch: allow | deny
  web_search: allow | deny
  subagents: allow | deny
  plan_tool: allow | deny
  view_image: allow | deny
mcp_tools: { <server>: [<tool>…] }
hooks: { background_shell, force_push, no_verify, default_branch_commit, write_scope }
sandbox: enabled
```

Command rules are vendor-neutral command prefixes:
- `"git push"` refuses `git push …`.
- A trailing `*` also matches a longer first word: `"sudo*"` refuses `sudoedit`.
- `"find ... -exec"` matches the flag anywhere after the prefix, including `--flag=value` and a short flag with its value attached.

The Claude adapter renders a rule as `Bash(<prefix>:*)`, or `Bash(<prefix>*)` for the trailing-`*` form. The Codex adapter renders a prefix rule as an execpolicy `prefix_rule`. The flag-anywhere form is not a prefix, so on Codex the generated hook enforces it alone.

`resolveRoleGrants` turns a contract into the per-vendor tables the generators read (`RoleGrants`). Those tables are derived and never written by hand. **Any built-in that no allowed capability names is denied.**

### Claude Code (`claude-code/capabilities.ts`)

| Capability | Claude built-ins it allows | Also |
|---|---|---|
| read_files | Read, Grep, Glob, LSP, Skill | |
| run_commands | Bash, KillShell, Monitor | The `allow` and `deny` rules become `Bash(…)` permissions. `default: allow` adds a bare `Bash` allow. |
| write_files | Edit, Write, NotebookEdit | The roots become the sandbox's `filesystem.allowWrite`. |
| plan_tool | TodoWrite, TaskCreate, TaskGet, TaskList, TaskUpdate | |
| subagents | Agent, Task, TaskOutput, TaskStop, Workflow | |
| web_fetch | WebFetch | |
| web_search | WebSearch | |
| view_image | (none: Read reads images) | |
| any mcp_tools | ToolSearch, which loads deferred MCP tool schemas | One `mcp__server__tool` allow per tool. |

`network` becomes the sandbox's domain allowlist.

### Codex (`codex/capabilities.ts`)

| Capability | Codex built-ins it allows | Also |
|---|---|---|
| read_files | exec_command, write_stdin | Codex reads through its shell. See below. |
| run_commands | exec_command, write_stdin | The rules become execpolicy `prefix_rule`s and hook rules. |
| write_files | apply_patch | `workspace-write` sandbox with these `writable_roots`. `deny` gives a `read-only` sandbox. |
| plan_tool | update_plan | |
| subagents | spawn_agent, resume_agent, wait_agent, close_agent | send_input is never granted. |
| web_fetch | web_fetch | |
| web_search | web_search | |
| view_image | view_image | |

`network` becomes the network proxy's domain list.

### Reviewers: a read-only shell

A reviewer (`read_files: allow`, `run_commands: deny`, `write_files: deny`) reads but never writes, and that holds on both vendors twice over.

1. **Sandbox.** No writable path: Claude's `allowWrite` is empty, and Codex runs `sandbox_mode = "read-only"` with no `writable_roots`. No write tool is granted: Claude Write/Edit/NotebookEdit, Codex apply_patch.
2. **Rules.** Claude has no shell at all. Codex has a shell limited to the reading-only commands, and the write-capable forms of those commands are refused (`find -exec/-execdir/-ok/-delete/-fprint*/-fls`, `git -c`, `git diff|log|show --output/--ext-diff/--textconv`, `rg --pre`). A role with no writable root may not redirect output into a file (`>`, `>>`, `N>`, `&>`, inside a subshell too), on both vendors' hooks. `2>&1` and `/dev/null` stay allowed.

The Codex reviewer keeps the shell because it mirrors how the standalone loop runs Codex reviewers, and `read_source` alone cannot show the diff or the checkout.

When a role has `read_files: allow` and `run_commands: deny`, its Codex shell may run only `CODEX_READ_ONLY_COMMANDS` (cat, head, tail, rg, grep, ls, find, wc, git diff/log/show/status; no sed, whose `w`/`e` script commands write files and run commands). `CODEX_READ_ONLY_FORBIDDEN` holds the forge, commit, install and host commands, and is always refused. The Claude side of the same role gets no shell and reads with Read/Grep/Glob.

### Parity

`normalizedCapabilities` (`policy.ts`) and the parity test derive what a role can effectively do on each vendor from what was generated:

- **read_files**: Claude Read; Codex shell.
- **run_commands**: Claude Bash; Codex shell beyond the reading-only commands.
- **write_files**: write tools plus a writable root (and, for Codex, workspace-write).
- **plan**, **view_image**, **web_fetch**, **web_search**, **subagents**.

The test requires both vendors to agree for every role and for every combination of capabilities.
