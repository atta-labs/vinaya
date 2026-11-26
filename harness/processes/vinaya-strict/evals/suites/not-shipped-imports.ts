// The import reading of the not-shipped test, kept apart from the test so a registry can run it on a fixture tree.
// Imports are read by the TypeScript compiler's own pre-processor (static imports, re-exports, `import()` and
// `require`), not by a text pattern; a relative specifier and an aliased one both name a path of the repository.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { resolveAliasedPath } from '@harness/kernel/imports/alias-table.js'

/**
 * The absolute paths `file` imports, re-exports or loads by a relative or an aliased specifier. A path is not
 * extension-resolved: it names the module as written. `repoRoot` locates the alias table; with no table, an aliased
 * specifier is a package name and names no path.
 */
export function importedPaths(file: string, repoRoot: string): string[] {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
  const out: string[] = []
  for (const { fileName } of info.importedFiles) {
    if (fileName.startsWith('.')) {
      out.push(resolve(dirname(file), fileName))
      continue
    }
    const aliased = resolveAliasedPath(repoRoot, fileName)
    if (aliased !== null) out.push(resolve(repoRoot, aliased))
  }
  return out
}
