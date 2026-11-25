/**
 * The repository's import alias table, read once from the shared base config.
 *
 * Every harness and script reader that follows imports reads the table here and
 * hands it to the one matching rule in the test-selection library
 * (`resolveAliasedSpecifier`); no reader keeps its own reading or its own rule.
 * The one exception is the CI base guard, which runs from the base commit alone
 * and imports nothing but the runtime.
 *
 * The caller names the repository root. Nothing is found relative to this file
 * or the working directory: in a published bundle this file sits nowhere near a
 * repository, and several readers run in repositories that have no such config.
 * A root with no base config, an empty file or a file that does not parse is an
 * empty table, never an exception, and an empty table makes every reader give
 * the result it gave before aliases existed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { type PathAlias, type PathAliasTable, resolveAliasedSpecifier } from '@attalabs/test-selection'

/** Where the shared base config sits, relative to the repository root. */
export const BASE_CONFIG_PATH = 'packages/typescript-config/base.json'

/**
 * The aliases a base config's text declares, as repository-relative folders. Only a wildcard entry with one wildcard
 * target that stays inside the repository is an alias; every other `paths` entry (an exact package path, say) is not.
 */
export function parseAliasTable(configText: string, configPath: string = BASE_CONFIG_PATH): PathAliasTable {
  let document: unknown
  try {
    document = JSON.parse(configText)
  } catch {
    return []
  }
  const options = (document as { compilerOptions?: unknown } | null)?.compilerOptions
  const paths = (options as { paths?: unknown } | null | undefined)?.paths
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return []
  const out: PathAlias[] = []
  for (const [key, targets] of Object.entries(paths as Record<string, unknown>)) {
    if (!key.endsWith('/*') || !Array.isArray(targets) || targets.length !== 1) continue
    const target = targets[0]
    if (typeof target !== 'string' || !target.endsWith('/*')) continue
    const directory = posix.normalize(posix.join(posix.dirname(configPath), target.slice(0, -1))).replace(/\/$/, '')
    if (directory === '' || directory === '.' || directory.startsWith('..')) continue
    out.push({ prefix: key.slice(0, -1), directory: `${directory}/` })
  }
  return out
}

const cache = new Map<string, { stamp: string; table: PathAliasTable }>()

/** The alias table of the repository at `repoRoot`; empty when it has no readable base config. */
export function readAliasTable(repoRoot: string): PathAliasTable {
  const file = join(repoRoot, BASE_CONFIG_PATH)
  try {
    if (!existsSync(file)) return []
    const stat = statSync(file)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    const held = cache.get(file)
    if (held && held.stamp === stamp) return held.table
    const table = parseAliasTable(readFileSync(file, 'utf8'), BASE_CONFIG_PATH)
    cache.set(file, { stamp, table })
    return table
  } catch {
    return []
  }
}

/** The repository-relative path an aliased specifier names (extension not applied), or `null` when it is not aliased. */
export function resolveAliasedPath(repoRoot: string, specifier: string): string | null {
  return resolveAliasedSpecifier(specifier, readAliasTable(repoRoot))
}
