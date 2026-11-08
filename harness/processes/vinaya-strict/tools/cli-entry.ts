/**
 * The script that starts the Vinaya CLI, for commands this process runs as the CLI (a detached
 * `task run` relaunch). Normally that is this process's own entry (`process.argv[1]`).
 * A runner that hosts the CLI's code without being the CLI (the Engine runner) names the real entry in
 * `VINAYA_CLI_ENTRY`, since its own `argv[1]` is the runner script. A program the CLI no longer routes
 * (`check`, `pr report`, the tool bridge) is started from the program table (`programs.ts`) instead.
 */
export const CLI_ENTRY_ENV = 'VINAYA_CLI_ENTRY'

export function cliEntryPath(): string {
  const named = process.env[CLI_ENTRY_ENV]
  return named !== undefined && named.length > 0 ? named : (process.argv[1] as string)
}
