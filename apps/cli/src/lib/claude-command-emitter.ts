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
// unescaped string replace (github.com/anthropics/claude-code issue #16163) —
// Claude Code itself does not sanitize the role token before it reaches the
// shell. This file does NOT duplicate role validation; it trusts the
// downstream gate instead. `vinaya doctrine --role`'s handling (`doctrine.ts`)
// already validates the role argument against the exact set of role names
// discovered from `aeg-root/roles/*.md` and refuses anything else BEFORE it
// resolves to a path — that is the load-bearing check, and it must never be
// weakened or bypassed by a future edit to either file.

import type { CreateFileOp } from './ops.js'

export const CLAUDE_COMMAND_GROUP = 'Claude Code command (.claude/commands/)'

/** The repo-root-relative path of the generated Claude Code command file. */
export const CLAUDE_COMMAND_PATH = '.claude/commands/vinaya.md'

/**
 * Render the `/vinaya <role>` command file content. `allowed-tools` scopes
 * the command to `vinaya doctrine` invocations only, so it runs without a
 * permission prompt. Bare `$ARGUMENTS` (not `$ARGUMENTS[0]`/`$1`) is used
 * deliberately for maximum Claude Code version compatibility, since only one
 * value — the role — is ever needed.
 */
export function renderClaudeCommand(): string {
  return `---
description: Act as an AEG role for this repo.
allowed-tools: Bash(vinaya doctrine *)
---
!\`vinaya doctrine --role $ARGUMENTS\`
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
