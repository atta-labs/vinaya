// Emitter for .claude/commands/vinaya.md
//
// Generates ONE parameterized Claude Code slash command, `/vinaya <role>`,
// using Claude Code's `$ARGUMENTS` substitution (code.claude.com/docs/en/skills
// — "Available string substitutions") to shell out to `vinaya doctrine --role`
// at read time. Unlike `.agents/skills/`'s emitter, this is a single static
// file, not one per role: the role is supplied at invocation via `$ARGUMENTS`,
// so there is nothing to discover from `aeg-root/roles/*.md` here.
//
// Security note: `$ARGUMENTS` substitutes into the shell command as a raw,
// PRE-SHELL text splice (github.com/anthropics/claude-code issue #16163) —
// the substitution happens before bash ever parses the line, so the role
// token can contain live shell syntax, not just an inert string.
//
// `"$ARGUMENTS"` (double-quoted) is deliberate, not decorative: it defeats
// the `;`/`|`/`&&`/`||` class of injection that the cited issue's own
// apostrophe repro demonstrates (a bare, unquoted `$ARGUMENTS` splits into a
// second shell command on any of those). It does NOT defeat every class —
// verified empirically, not assumed:
//   - `$(...)`/backtick command substitution still executes even inside
//     double quotes (bash's own documented behavior — double quotes suppress
//     word-splitting and glob/separator characters, never command
//     substitution).
//   - No quote character (single or double) can be made airtight against a
//     raw pre-shell splice at all: whichever quote this template opens, an
//     attacker's token can contain that same quote character, close it
//     early, inject an arbitrary command, then reopen a matching quote so
//     the rest of the line still parses — proven live: a `case`/allowlist
//     guard placed AFTER a single-quoted capture (`ROLE='$ARGUMENTS'; case
//     "$ROLE" in …) still let an injected `touch` run, because the shell
//     executes left-to-right and the injected command lands before the
//     guard ever gets control. There is no in-template ordering that puts
//     validation before an attacker-chosen quote-breakout.
//
// `vinaya doctrine --role`'s own handling (`doctrine.ts`) validates the
// argument it actually receives against the exact set of role names
// discovered from `aeg-root/roles/*.md` and refuses anything else — that
// check is real and airtight for ITS OWN scope, but an injected `$(...)` or
// quote-breakout command never reaches it as an argument at all; it runs at
// the shell level first. The actual remaining backstop is Claude Code's own
// `allowed-tools: Bash(vinaya doctrine *)` permission matcher refusing to
// silently auto-run a chained/injected command that doesn't literally reduce
// to the allowed prefix — a platform property this repo cannot verify or
// control. Do not extend this file's own doc or tests to claim the
// injection class is closed; it is reduced, not closed, until that platform
// behavior is confirmed.

import type { CreateFileOp } from './ops.js'

export const CLAUDE_COMMAND_GROUP = 'Claude Code command (.claude/commands/)'

/** The repo-root-relative path of the generated Claude Code command file. */
export const CLAUDE_COMMAND_PATH = '.claude/commands/vinaya.md'

/**
 * Render the `/vinaya <role>` command file content. `allowed-tools` scopes
 * the command to `vinaya doctrine` invocations only, so it runs without a
 * permission prompt. Bare `$ARGUMENTS` (not `$ARGUMENTS[0]`/`$1`) is used
 * deliberately for maximum Claude Code version compatibility, since only one
 * value — the role — is ever needed. Double-quoted (`"$ARGUMENTS"`), not
 * bare — see the module doc above for exactly what that does and does not
 * close.
 */
export function renderClaudeCommand(): string {
  return `---
description: Act as an AEG role for this repo.
allowed-tools: Bash(vinaya doctrine *)
---
!\`vinaya doctrine --role "$ARGUMENTS"\`
`
}

/** Build the single `create-file` op for the generated command file. */
export function buildClaudeCommandOps(): CreateFileOp[] {
  return [
    {
      kind: 'create-file',
      path: CLAUDE_COMMAND_PATH,
      content: renderClaudeCommand(),
      group: CLAUDE_COMMAND_GROUP
    }
  ]
}
