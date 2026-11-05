/**
 * Vinaya's protected-path policy: the administrative policy paths a task may
 * write only when its Surface's `in:` globs cover them. The list is
 * `PROTECTED_ADMIN_PATHS`, and the answer is `isProtectedAdminPath` — the one
 * implementation the `surface-scope` check (`checkSurfaceScope`) also reads,
 * so the broker and the check never hold two copies of the list.
 */

import { isProtectedAdminPath } from '../../tools/task-contract/protected-paths'
import type { ProtectedPathPolicy } from '../../../../kernel/tools/host/broker.js'

export const VINAYA_PROTECTED_PATHS: ProtectedPathPolicy = {
  isProtected: (normalizedPath) => isProtectedAdminPath(normalizedPath)
}
