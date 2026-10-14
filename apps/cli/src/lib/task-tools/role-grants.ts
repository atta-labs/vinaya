/**
 * The capability grants (`apps/cli/specs/dev-review-capabilities-contracts.md`
 * §3): the one table naming, per dispatched role, the agent-facing tools it
 * may call. The driver-run tool server (`dev-tools-server.ts`) reads it twice
 * for every dispatch — to list only the tools the dispatched role is granted,
 * and to refuse a call to any other tool before any handler runs — so the
 * grant is enforced inside the driver, never by an agent's own permission
 * rules. MCP annotations (read-only, destructive, idempotent, open-world) are
 * discovery hints and play no part here.
 *
 * The Operator's tools are a separate server (`server.ts`) with its own
 * launch, and are not granted through this table.
 */

import { DEV_TOOL_CATALOG } from './tool-catalog.js'

/** The roles the driver dispatches against this table. The controller is listed so its empty grant is explicit, not implied. */
export const GRANTED_ROLES = ['developer', 'code-reviewer', 'security', 'controller'] as const

export type GrantedRole = (typeof GRANTED_ROLES)[number]

/**
 * Per role, every tool it may call. A reviewer's `read_source` is granted
 * here but is still a planned catalog entry with no handler, so no server
 * lists or runs it until it exists (`servedTools`).
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

export function isGrantedRole(role: string): role is GrantedRole {
  return (GRANTED_ROLES as readonly string[]).includes(role)
}

/** Whether `role` may call `tool`. A role outside the table is granted nothing. */
export function isToolGranted(role: string, tool: string): boolean {
  return isGrantedRole(role) && ROLE_TOOL_GRANTS[role].includes(tool)
}

/**
 * The live tools a dispatch of `role` is served, in catalog order:
 * the role's grant intersected with the tools the driver has a handler for.
 */
export function servedTools(role: GrantedRole): typeof DEV_TOOL_CATALOG {
  return DEV_TOOL_CATALOG.filter((tool) => isToolGranted(role, tool.name))
}
