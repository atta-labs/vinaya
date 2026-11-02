/**
 * The one composition module every builder calls for its policies: the broker
 * (`createBroker`), the per-turn worker boundary (`createWorkerBoundary`), the
 * driver-run tool server and host (`createDevToolsMcpServer`,
 * `startDevToolsHost`) and the task-tool router (`createTaskToolRouter`). Each
 * of those refuses to build without its policies; this module is where Vinaya
 * supplies them, from the implementations beside it (`roles.ts`,
 * `protected-paths.ts`, `scratch-names.ts`, `launch-records.ts`).
 *
 * Only a builder imports this module. A reader of one Vinaya fact (a grant
 * table, the role names) imports the implementation module that holds it.
 */

import type { BrokerPolicies, ProtectedPathPolicy } from '../../../../../apps/cli/src/lib/broker.js'
import type { ToolGrantPolicy } from '../../../../../apps/cli/src/lib/task-tools/role-grants.js'
import type { RouterRolePolicy } from '../../../../../apps/cli/src/lib/task-tools/router.js'
import type { WorkerBoundaryPolicies } from '../../../../../apps/cli/src/lib/worker-boundary.js'
import type { DispatchTeeRecoveryDeps } from '../../loops/dev-review/dispatch/dispatch.js'
import { vinayaLaunchRecordVerifier } from './launch-records.js'
import { VINAYA_PROTECTED_PATHS } from './protected-paths.js'
import { VINAYA_BOUNDARY_ROLES, VINAYA_BROKER_ROLES, VINAYA_ROUTER_ROLES, VINAYA_TOOL_GRANTS } from './roles.js'
import { VINAYA_SCRATCH_NAMES } from './scratch-names.js'

/**
 * The broker's three policies. `launchRecordDeps` replaces the runtime
 * directory walk the launch-record verifier reads (a fixture's in-memory
 * launch records); absent, it reads this machine's real launch records.
 */
export function vinayaBrokerPolicies(options: { launchRecordDeps?: DispatchTeeRecoveryDeps } = {}): BrokerPolicies {
  return {
    protectedPaths: VINAYA_PROTECTED_PATHS,
    launchRecords: vinayaLaunchRecordVerifier(options.launchRecordDeps),
    roles: VINAYA_BROKER_ROLES
  }
}

/** The protected-path policy alone, for a builder that previews the broker's protected-path refusal before it requests the push. */
export function vinayaProtectedPathPolicy(): ProtectedPathPolicy {
  return VINAYA_PROTECTED_PATHS
}

export function vinayaWorkerBoundaryPolicies(): WorkerBoundaryPolicies {
  return { roles: VINAYA_BOUNDARY_ROLES, scratchNames: VINAYA_SCRATCH_NAMES }
}

export function vinayaToolGrantPolicy(): ToolGrantPolicy {
  return VINAYA_TOOL_GRANTS
}

export function vinayaRouterPolicies(): { roles: RouterRolePolicy } {
  return { roles: VINAYA_ROUTER_ROLES }
}
