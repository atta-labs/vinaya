import { realpathSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `moduleUrl` (pass `import.meta.url`) is the script
 * named `scriptName` (its file name without extension) the runtime was started
 * on. Bundled bins use this instead of `import.meta.main`, which the CLI build
 * rewrites to a CommonJS `__require.main` check that throws on load under ESM
 * when no `__require` shim is emitted. Both paths are resolved through
 * `realpathSync` because the installed CLI is reached through a symlinked bin.
 * `scriptName` is needed because a bundle that inlines this module into another
 * entry (the CLI's own `index.js`) gives every inlined module that entry's URL.
 */
export function isEntryPoint(
  moduleUrl: string,
  scriptName: string,
  startedOn: string | undefined = process.argv[1]
): boolean {
  if (!startedOn) return false
  try {
    const started = realpathSync(startedOn)
    return basename(started, extname(started)) === scriptName && realpathSync(fileURLToPath(moduleUrl)) === started
  } catch {
    return false
  }
}
