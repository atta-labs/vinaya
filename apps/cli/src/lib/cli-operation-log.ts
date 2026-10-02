/**
 * The one `operation` event every CLI invocation records as the process ends
 * (`apps/cli/specs/log.md` § Every CLI invocation records one operation). The
 * pieces are pure — argv to target, exit code to result — so `index.ts`'s exit
 * handler holds no logic of its own and a test can drive each without a
 * process.
 *
 * A target never carries an argument: it comes from the fixed tables below, and
 * anything not in them is `unknown`. An argument can carry a secret.
 */

import type { LogEventInput, LogSyncOptions } from './log-sink.js'

/** The operation name every CLI invocation records. */
export const CLI_OPERATION = 'cli_command'

/** The target of an invocation whose command is in no table below. */
export const UNKNOWN_CLI_TARGET = 'unknown'

/**
 * Every command's first word, as the published command catalog
 * (`packages/sources/src/commands.ts`) names them. `help` also answers a bare
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
  task: new Set(['dispatch', 'brief', 'run', 'status', 'sweep'])
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
 * The event for one finished invocation, or `null` for the drain's own
 * (`vinaya log send`), which never records. The exit code is the error class,
 * for every result; the duration is the process's, from its start to `now`.
 */
export function cliOperationEvent(args: readonly string[], exitCode: number, durationMs: number): LogEventInput | null {
  const target = cliOperationTarget(args)
  if (target === DRAIN_TARGET) return null
  return {
    kind: 'operation',
    event: 'completed',
    payload: {},
    operation: CLI_OPERATION,
    target,
    result: cliOperationResult(exitCode),
    error_class: String(exitCode),
    duration_ms: Math.max(0, Math.round(durationMs))
  }
}

/**
 * Registers the exit handler that records the invocation's one event, so
 * every way the process ends is covered by this one place — a normal return,
 * and `process.exit(n)` from anywhere inside a command. The handler is
 * synchronous (`logSync`), prints nothing, never throws and never changes the
 * exit code. A process ended by a signal never runs it: the one gap.
 */
export function recordCliOperationAtExit(
  args: readonly string[],
  deps: {
    on: (event: 'exit', handler: (code: number) => void) => unknown
    logSync: (e: LogEventInput, opts?: LogSyncOptions) => void
    now: () => number
  }
): void {
  const startedAt = deps.now()
  deps.on('exit', (code) => {
    try {
      const event = cliOperationEvent(args, code, deps.now() - startedAt)
      if (event !== null) deps.logSync(event, { quiet: true })
    } catch {
      // Runs as the process ends: nothing may throw or print here.
    }
  })
}
