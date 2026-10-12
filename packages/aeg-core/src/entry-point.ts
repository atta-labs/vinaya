import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `moduleUrl` (pass `import.meta.url`) is the script the
 * runtime was started on. Bundled bins use this instead of `import.meta.main`,
 * which the CLI build rewrites to a CommonJS `__require.main` check that
 * throws on load under ESM when no `__require` shim is emitted. Both sides are
 * resolved through `realpathSync` because the installed CLI is reached through
 * a symlinked bin.
 */
export function isEntryPoint(moduleUrl: string, startedOn: string | undefined = process.argv[1]): boolean {
  if (!startedOn) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(startedOn)
  } catch {
    return false
  }
}
