import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The script that starts the Vinaya CLI, for commands this process runs as the CLI (`check --all`,
 * `pr report --push`, a detached relaunch). Normally that is this process's own entry (`process.argv[1]`).
 * A runner that hosts the CLI's code without being the CLI (the Engine runner) names the real entry in
 * `VINAYA_CLI_ENTRY`, since its own `argv[1]` is the runner script.
 */
export const CLI_ENTRY_ENV = 'VINAYA_CLI_ENTRY'

export function cliEntryPath(): string {
  const named = process.env[CLI_ENTRY_ENV]
  return named !== undefined && named.length > 0 ? named : (process.argv[1] as string)
}

/**
 * The tool bridge program an agent's sandbox runs to reach the driver's dev-tools host: the built file
 * beside the CLI's bundle (`dist/kernel/tools/host/dev-tools-bridge.js`) when the CLI runs from its bundle,
 * the kernel's source file (`harness/kernel/tools/host/dev-tools-bridge.ts`) when it runs from source.
 */
export function devBridgePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const built = join(here, 'kernel', 'tools', 'host', 'dev-tools-bridge.js')
  if (existsSync(built)) return built
  return resolve(here, '..', '..', '..', '..', 'harness', 'kernel', 'tools', 'host', 'dev-tools-bridge.ts')
}
