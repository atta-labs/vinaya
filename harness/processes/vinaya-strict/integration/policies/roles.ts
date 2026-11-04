/**
 * Vinaya's role facts — every role name the broker, the per-turn worker
 * boundary, the driver-run tool server and the task-tool router enforce
 * against. The enforcing modules hold the logic and name no role; they read
 * these facts through the policies `vinaya-policies.ts` composes.
 */

import { OPERATOR_TOOL_GRANT } from '../../../../kernel/tools/catalog/task-tools'
import { ROLE_VALUES } from '../../../../kernel/log/schema'
import type { BrokerRolePolicy } from '../../../../kernel/tools/host/broker.js'
import type { ToolGrantPolicy } from '../../../../kernel/tools/role-grants.js'
import type { RouterRolePolicy } from '../../../../kernel/tools/host/router.js'
import type { BoundaryRolePolicy } from '../../../../kernel/isolation/worker-boundary.js'

// --- tool grants (`apps/cli/specs/dev-review-capabilities-contracts.md` §3) --

/** The roles the driver dispatches against the tool server's grant table. The controller is listed so its empty grant is explicit, not implied. */
export const GRANTED_ROLES = ['developer', 'code-reviewer', 'security', 'controller'] as const

export type GrantedRole = (typeof GRANTED_ROLES)[number]

/**
 * Per role, every tool it may call: the Developer its seven tools, each
 * reviewer only `read_source` — the pinned required sources, never a URL
 * fetch or a Developer tool. The Operator's tools are a separate server with
 * its own launch, and are not granted through this table.
 */
export const ROLE_TOOL_GRANTS: Readonly<Record<GrantedRole, readonly string[]>> = {
  developer: [
    'fetch_documentation',
    'run_checks',
    'publish_changes',
    'open_pull_request',
    'update_pull_request_body',
    'refresh_evidence',
    'read_pull_request'
  ],
  'code-reviewer': ['read_source'],
  security: ['read_source'],
  controller: []
}

export const VINAYA_TOOL_GRANTS: ToolGrantPolicy = { roles: GRANTED_ROLES, grants: ROLE_TOOL_GRANTS }

// --- the broker ---------------------------------------------------------------

/**
 * The broker recognizes exactly the Log's role vocabulary (`ROLE_VALUES`), and
 * maps only the Developer — `isolation.md` §1's "Worker" row — to the Worker
 * grant. `code-reviewer` and `security` are real dispatched roles that hold no
 * Worker grant; `principal`, `planner`, `archivist` and `architect` are never
 * dispatched-child values at all. A protected-path refusal sends the path to
 * the Planner, who owns the task's Surface.
 */
export const VINAYA_BROKER_ROLES: BrokerRolePolicy = {
  recognizedRoles: ROLE_VALUES,
  workerRoles: ['developer'],
  surfaceOwner: 'the Planner'
}

// --- the per-turn worker boundary --------------------------------------------

/**
 * The sessions area names a role by prefix; `code-reviewer` is listed first
 * because its own hyphen would otherwise read as role `code`. The Developer's
 * round directory is literally `developer`; a reviewer's is `reviewer-work` or
 * `security-work`, with a `-retry<k>` or `-redispatch<k>` sibling — the result
 * directories reviewers wrote before they returned their review as structured
 * output, still attributed to their role. The code and security reviewers
 * are dispatched concurrently, in one `Promise.all`, for the same round.
 */
export const VINAYA_BOUNDARY_ROLES: BoundaryRolePolicy = {
  sessionRoles: ['code-reviewer', 'developer', 'security'],
  roundDirectory: (role) => {
    if (role === 'developer') return { name: 'developer', suffixed: false }
    return { name: role === 'code-reviewer' ? 'reviewer-work' : 'security-work', suffixed: true }
  },
  concurrentSibling: (role) => (role === 'code-reviewer' ? 'security' : role === 'security' ? 'code-reviewer' : null)
}

// --- the task-tool router -----------------------------------------------------

/**
 * The Operator's grant (`aeg-root/roles/operator.md`'s allowed tools, mirrored
 * by `OPERATOR_TOOL_GRANT`), and the names its refusals print: a shell, a forge
 * write, an Issue edit, a review publish or a merge is asked of the Planner or
 * Principal instead.
 */
export const VINAYA_ROUTER_ROLES: RouterRolePolicy = {
  grantedTools: OPERATOR_TOOL_GRANT,
  seat: 'the Operator',
  askedOf: 'the Planner or Principal'
}
