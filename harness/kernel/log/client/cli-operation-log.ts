/**
 * The one `log.command.completed` record every CLI invocation writes as it ends
 * (`harness/kernel/log/log.md` § Every CLI invocation records one operation). The
 * pieces are pure — argv to target, exit code to result — so `index.ts`'s exit
 * handler holds no logic of its own and a test can drive each on its own.
 *
 * A target never carries an argument: it comes from the fixed tables below, and
 * anything not in them is `unknown`. An argument can carry a secret.
 */

import { type CommandRecord, writeCommand } from '../outside-log.js'

/** The operation name every CLI invocation records. */
export const CLI_OPERATION = 'cli_command'

/**
 * The folder file earlier versions appended a taskless invocation's event to —
 * `<folder>/<owner>-<repo>/none-cli-operations.ndjson`. An invocation no longer
 * writes it, but a machine that ran earlier versions still holds one, so a
 * concurrent test run's real-runtime guard
 * (`harness/kernel/conformance/unit/real-runtime-guard-core.ts`) keeps
 * exempting that file, and only it, and `vinaya log send` still delivers it as
 * unattributed.
 */
export const CLI_OPERATION_STREAM = 'none-cli-operations'

/** The target of an invocation whose command is in no table below. */
export const UNKNOWN_CLI_TARGET = 'unknown'

/**
 * Every command's first word, as the published command catalog
 * (`harness/processes/vinaya-strict/integration/commands.ts`) names them. `help` also answers a bare
 * `vinaya`, `--help` and `-h`. The test over the catalog fails when a command is
 * added there and not here.
 */
const COMMAND_NAMES: ReadonlySet<string> = new Set([
  'help',
  'version',
  'init',
  'check',
  'commit-msg',
  'new',
  'brief',
  'task',
  'task-tools',
  'pr',
  'issue',
  'milestone',
  'review',
  'doctor',
  'tokens',
  'doctrine',
  'upgrade',
  'archive',
  'audit',
  'eject',
  'demo',
  'waiver',
  'studio',
  'quickstart',
  'release',
  'dispatch',
  'dev-review-loop',
  'log',
  'sync'
])

/** The two commands whose subcommand is part of the target, and the subcommands that are. Any other subcommand records the command alone. */
const SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  log: new Set(['selftest', 'send']),
  task: new Set(['dispatch', 'brief', 'run', 'switch', 'status', 'sweep'])
}

/** The target `vinaya log send` maps to — the drain that delivers events, which records nothing, so delivery never logs itself. */
export const DRAIN_TARGET = 'log send'

/** The target for an invocation's arguments (`process.argv.slice(2)`): the command name, plus the `log`/`task` subcommand when it is in the fixed list, else `unknown`. */
export function cliOperationTarget(args: readonly string[]): string {
  const [command, subcommand] = args
  if (command === undefined || command === '--help' || command === '-h') return 'help'
  if (!COMMAND_NAMES.has(command)) return UNKNOWN_CLI_TARGET
  const subcommands = SUBCOMMANDS[command]
  return subcommands !== undefined && subcommand !== undefined && subcommands.has(subcommand)
    ? `${command} ${subcommand}`
    : command
}

/** `ok` for exit code 0, `refused` for 2 (the CLI's refusal code), `error` for anything else. */
export function cliOperationResult(exitCode: number): 'ok' | 'refused' | 'error' {
  if (exitCode === 0) return 'ok'
  return exitCode === 2 ? 'refused' : 'error'
}

/**
 * The command record for one finished invocation, or `null` for the drain's
 * own (`vinaya log send`), which never records. The exit code is the error
 * kind of any result that is not `ok`.
 */
export function cliOperationRecord(args: readonly string[], exitCode: number): CommandRecord | null {
  const target = cliOperationTarget(args)
  if (target === DRAIN_TARGET) return null
  const result = cliOperationResult(exitCode)
  return { action: CLI_OPERATION, target, result, ...(result === 'ok' ? {} : { errorType: String(exitCode) }) }
}

/**
 * Registers the exit handler that records the invocation's one command
 * record (`log.command.completed`), so every way the invocation ends is
 * covered by this one place — a normal return, and `process.exit(n)` from
 * anywhere inside a command. The handler is synchronous (the Log handle
 * writes as it is called), prints nothing, never throws and never changes the
 * exit code. An invocation ended by a signal never runs it: the one gap. The
 * record is written through the run's own handle, so it carries the run id
 * this invocation has, as it did before; `record` defaults to that write.
 */
export function recordCliOperationAtExit(
  args: readonly string[],
  deps: {
    on: (event: 'exit', handler: (code: number) => void) => unknown
    record?: (record: CommandRecord) => void
  }
): void {
  deps.on('exit', (code) => {
    try {
      const record = cliOperationRecord(args, code)
      if (record !== null) (deps.record ?? writeCommand)(record)
    } catch {
      // Runs as the invocation ends: nothing may throw or print here.
    }
  })
}
