/**
 * The agent-configuration scan's command resolver, shared by the standalone
 * review loop and the Engine path so both read the scanner the same way.
 */

import type { VinayaConfig } from '../config.js'
import { resolveSecurityScanCommand } from '../config.js'

/**
 * The configured scanner argv from the DEFAULT-BRANCH trust anchor — the
 * same source `reviewPolicy()`/`principalAllowlist()` read, never the pull
 * request's own checkout, so a pull request cannot choose the subprocess that
 * runs in the driver's environment by editing its own `vinaya.config.json`.
 * `loadTrustAnchorConfig` is the caller's reader of that anchor.
 */
export function resolveTrustAnchorSecurityScanCommand(
  loadTrustAnchorConfig: () => VinayaConfig | null
): readonly string[] | null {
  return resolveSecurityScanCommand(loadTrustAnchorConfig())
}
