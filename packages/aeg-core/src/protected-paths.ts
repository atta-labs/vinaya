import { posix as posixPath } from 'node:path'

/**
 * The administrative policy paths a task may write only when the `in:` globs
 * of its Issue's Surface cover them. The broker's push refusal and the
 * `surface-scope` check both read this one list.
 */
export const PROTECTED_ADMIN_PATHS = ['vinaya.config.json', '.vinaya/doc-owners', '.github/', 'aeg-root/'] as const

/**
 * Resolves the path as if rooted at a virtual `/` — via `posixPath.resolve`,
 * never `posixPath.normalize` — so `foo/../.github/workflows/ci.yml`,
 * `./.github/x`, an absolute `/aeg-root/x`, and a path that OPENS with an
 * unresolved `..` (`../.github/x`, `../../aeg-root/x`) all normalize to the
 * same string a plain `.github/x` or `aeg-root/x` would. `resolve` against a
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

/** True when the path, once normalized, is a protected administrative path or sits under one. */
export function isProtectedAdminPath(path: string): boolean {
  const normalized = normalizeTouchedPath(path)
  return PROTECTED_ADMIN_PATHS.some((prefix) => normalized === prefix || normalized.startsWith(prefix))
}
