/**
 * What the prose gates sweep as doctrine. An explicit `proseGates.doctrineRoot`
 * is a folder an adopter names, swept in full by the caller's own collector.
 * Unset, the sweep is the doctrine map's source paths — never every `.md`
 * under the process folder, which also holds role folders' READMEs and other
 * pages that are not doctrine.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DOCTRINE_REPO_PATHS, DOCTRINE_TREE } from './doctrine-map'

/**
 * The repository-relative doctrine files to sweep, relative to `cwd`: the
 * configured folder's files through `collect`, or every map source path that
 * exists when no folder is configured.
 */
export function doctrineSweepPaths(
  configuredRoot: string | undefined,
  collect: (dir: string) => string[],
  cwd: string = process.cwd()
): string[] {
  if (configuredRoot !== undefined) return collect(configuredRoot)
  return DOCTRINE_REPO_PATHS.filter((path) => existsSync(join(cwd, path)))
}

/** The doctrine root a gate names in its summary line — the configured folder, or the doctrine map's tree. */
export function doctrineRootLabel(configuredRoot: string | undefined): string {
  return configuredRoot ?? DOCTRINE_TREE
}

/** The prefix a path must carry to be swept doctrine: the configured folder's, or the doctrine map's tree. */
export function doctrineShipsPrefix(configuredRoot: string | undefined): string {
  return `${doctrineRootLabel(configuredRoot)}/`
}
