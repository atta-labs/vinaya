/**
 * Path aliases: a specifier that begins with a declared prefix names a folder
 * of the repository, the way a `paths` entry with a trailing wildcard does in a
 * TypeScript configuration. The library never reads that configuration — a
 * caller hands in the table — so a repository with no such file gets the empty
 * table and every specifier resolves exactly as it did before.
 */

/** One alias: `prefix` is what a specifier begins with (`@scope/dir/`), `directory` the repository-relative folder it names (`dir/`). Both end in `/`. */
export type PathAlias = { prefix: string; directory: string }

/** The aliases a repository declares; empty when it declares none. */
export type PathAliasTable = readonly PathAlias[]

/**
 * The repository-relative path an aliased specifier names (extension not
 * applied), or `null` when the specifier begins with no alias prefix. The
 * longest matching prefix wins, so a nested alias never shadows a longer one.
 */
export function resolveAliasedSpecifier(specifier: string, table: PathAliasTable | undefined): string | null {
  if (!table) return null
  let best: PathAlias | null = null
  for (const alias of table) {
    if (!specifier.startsWith(alias.prefix) || specifier.length === alias.prefix.length) continue
    if (!best || alias.prefix.length > best.prefix.length) best = alias
  }
  return best ? `${best.directory}${specifier.slice(best.prefix.length)}` : null
}
