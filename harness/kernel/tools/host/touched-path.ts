import { posix as posixPath } from 'node:path'

/**
 * Resolves the path as if rooted at a virtual `/` — via `posixPath.resolve`,
 * never `posixPath.normalize` — so `foo/../.github/workflows/ci.yml`,
 * `./.github/x`, an absolute `/<folder>/x`, and a path that OPENS with an
 * unresolved `..` (`../.github/x`, `../../<folder>/x`) all normalize to the
 * same string a plain `.github/x` or `<folder>/x` would. `resolve` against a
 * root has nowhere to go past that root, so a leading `..` collapses to the
 * root itself instead of surviving in the output — `normalize` alone has no
 * such floor and leaves an unresolvable leading `..` untouched, which is
 * exactly the disguise that got past an earlier version of the broker's
 * check (`../.github/workflows/ci.yml` normalized to itself, never matching
 * the `.github/` prefix). The leading `/` that `resolve` adds is stripped after.
 */
export function normalizeTouchedPath(path: string): string {
  return posixPath.resolve('/', path.replace(/\\/g, '/')).replace(/^\/+/, '')
}
