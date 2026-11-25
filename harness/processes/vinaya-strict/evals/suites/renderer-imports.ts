// The import scan of the renderer test, kept apart from the test so a registry can run it on a fixture tree.
import { posix } from 'node:path'
import { resolveAliasedPath } from '@harness/kernel/imports/alias-table.js'

/**
 * The repository paths (as `.ts` files) a source text imports at run time — type-only imports excluded — by a relative
 * or an aliased specifier. `importerPath` is the repository-relative path of the file the text belongs to; `repoRoot`
 * locates the alias table, and with no table an aliased specifier names no path.
 */
export function runtimeImportPaths(source: string, importerPath: string, repoRoot: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/^import (?!type )[^;]*? from '([^']+)'/gm)) {
    const specifier = m[1] as string
    const named = specifier.startsWith('.')
      ? posix.join(posix.dirname(importerPath), specifier)
      : resolveAliasedPath(repoRoot, specifier)
    if (named === null) continue
    out.push(`${posix.normalize(named).replace(/\.js$/, '')}.ts`)
  }
  return out
}
