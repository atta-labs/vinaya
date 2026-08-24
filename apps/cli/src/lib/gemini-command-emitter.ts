// Emitter for .gemini/commands/vinaya.toml
//
// Generates ONE parameterized custom command for Gemini CLI, invoked
// `/vinaya <role>`. Gemini CLI's own `{{args}}` substitution
// (geminicli.com/docs/cli/custom-commands/) drops the resolved role straight
// into an embedded `!{...}` shell directive before it executes, and the CLI
// itself shell-escapes that substitution automatically — no equivalent
// hardening is needed here to what the Claude Code sibling emitter
// (`.claude/commands/vinaya.md`, task 3) requires for `$ARGUMENTS`.
//
// Role-argument validation (an unknown role name refuses cleanly, listing
// the valid ones) lives once, in `vinaya doctrine --role` itself
// (`commands/doctrine.ts`) — never duplicated per-emitter. Gemini's own
// escaping only makes the shell substitution safe against injection; it says
// nothing about whether the substituted value names a real role, which is
// `doctrine.ts`'s job alone.
//
// Gemini CLI prompts the user to confirm the exact resolved shell command
// before it runs, every time, with no documented bypass — this emitter's
// generated file and description must never read as if execution were
// silent or automatic.

import type { CreateFileOp } from './ops.js'

export const GEMINI_COMMAND_GROUP = 'Gemini CLI command (.gemini/commands/)'

/** The repo-root-relative path of the generated Gemini CLI custom command. */
export const GEMINI_COMMAND_PATH = '.gemini/commands/vinaya.toml'

/** Render the parameterized `.gemini/commands/vinaya.toml` content. */
export function renderGeminiCommand(): string {
  return `description = "Act as an AEG role for this repo."
prompt = "!{vinaya doctrine --role {{args}}}"
`
}

/** Build the `create-file` op for the Gemini CLI custom command. */
export function buildGeminiCommandOp(): CreateFileOp {
  return {
    kind: 'create-file',
    path: GEMINI_COMMAND_PATH,
    content: renderGeminiCommand(),
    group: GEMINI_COMMAND_GROUP
  }
}
