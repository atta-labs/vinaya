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
//     the rest of the line still parses. Proven against the template's own
//     double-quote style by this file's own test suite
//     (`claude-command-emitter.test.ts`'s "a quote-breakout payload still
//     executes" case). The same reasoning applies to any other quote
//     character a future template might pick instead (e.g. a single-quoted
//     capture followed by a validation guard): the shell executes
//     left-to-right, so an injected command inside the breakout always lands
//     before a later guard gets control — there is no in-template ordering
//     that puts validation before an attacker-chosen quote-breakout.
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
import type { VendoredVinaya } from './self-host.js'

export const CLAUDE_COMMAND_GROUP = 'Claude Code command (.claude/commands/)'

/** The repo-root-relative path of the generated Claude Code command file. */
export const CLAUDE_COMMAND_PATH = '.claude/commands/vinaya.md'

/**
 * The doctrine invocation this command shells out to — the source CLI
 * (`bun <dir>/src/index.ts doctrine`) in a repo that vendors `vinaya` as a
 * workspace member, the global binary otherwise. A self-hosting repo's own
 * `/vinaya` command must invoke the CLI it is actually editing, never
 * whatever release the global install happens to be at (atta-labs/vinaya#408).
 * Also the literal prefix `allowed-tools` below matches — both must change
 * together, or the permission matcher stops recognizing the emitted command.
 */
function doctrineInvocation(selfHost: VendoredVinaya | null): string {
  return selfHost ? `bun ${selfHost.dir}/src/index.ts doctrine` : 'vinaya doctrine'
}

/**
 * Render the `/vinaya <role>` command file content. `allowed-tools` scopes
 * the command to its own doctrine invocation only, so it runs without a
 * permission prompt. Bare `$ARGUMENTS` (not `$ARGUMENTS[0]`/`$1`) is used
 * deliberately for maximum Claude Code version compatibility, since only one
 * value — the role — is ever needed. Double-quoted (`"$ARGUMENTS"`), not
 * bare — see the module doc above for exactly what that does and does not
 * close.
 */
export function renderClaudeCommand(selfHost: VendoredVinaya | null = null): string {
  const invocation = doctrineInvocation(selfHost)
  return `---
description: Act as an AEG role for this repo.
allowed-tools: Bash(${invocation} *)
---
!\`${invocation} --role "$ARGUMENTS"\`
`
}

/** Build the single `create-file` op for the generated command file. */
export function buildClaudeCommandOps(selfHost: VendoredVinaya | null = null): CreateFileOp[] {
  return [
    {
      kind: 'create-file',
      path: CLAUDE_COMMAND_PATH,
      content: renderClaudeCommand(selfHost),
      group: CLAUDE_COMMAND_GROUP
    }
  ]
}
