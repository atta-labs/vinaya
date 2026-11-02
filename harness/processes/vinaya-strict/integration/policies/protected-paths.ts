/**
 * Vinaya's protected-path policy: the administrative policy paths a task may
 * write only when its Surface's `in:` globs cover them. The list is
 * `PROTECTED_ADMIN_PATHS`, and the answer is `isProtectedAdminPath` — the one
 * implementation the `surface-scope` check (`checkSurfaceScope`) also reads,
 * so the broker and the check never hold two copies of the list.
 */

import { isProtectedAdminPath } from '@attalabs/aeg-core'
import type { ProtectedPathPolicy } from '../../../../../apps/cli/src/lib/broker.js'

export const VINAYA_PROTECTED_PATHS: ProtectedPathPolicy = {
  isProtected: (normalizedPath) => isProtectedAdminPath(normalizedPath)
}
