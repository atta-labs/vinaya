import { normalizeTouchedPath } from '@attalabs/harness/tools/host/touched-path'

/**
 * The administrative policy paths a task may write only when the `in:` globs
 * of its Issue's Surface cover them. The broker's push refusal and the
 * `surface-scope` check both read this one list.
 */
export const PROTECTED_ADMIN_PATHS = ['vinaya.config.json', '.vinaya/doc-owners', '.github/', 'aeg-root/'] as const

/** True when the path, once normalized, is a protected administrative path or sits under one. */
export function isProtectedAdminPath(path: string): boolean {
  const normalized = normalizeTouchedPath(path)
  return PROTECTED_ADMIN_PATHS.some((prefix) => normalized === prefix || normalized.startsWith(prefix))
}
