/**
 * The capability grants (the review-loop specification
 * §3): the one table naming, per dispatched role, the agent-facing tools it
 * may call. The driver-run tool server (`dev-tools-server.ts`) reads it twice
 * for every dispatch — to list only the tools the dispatched role is granted,
 * and to refuse a call to any other tool before any handler runs — so the
 * grant is enforced inside the driver, never by an agent's own permission
 * rules. MCP annotations (read-only, destructive, idempotent, open-world) are
 * discovery hints and play no part here.
 *
 * The table itself is a tool-grant policy the process supplies: this module
 * holds only the membership logic and names no role. A server or host built
 * without a policy is refused (`assertToolGrantPolicy`), never served an
 * empty or default grant.
 */

import { AGENT_TOOL_CATALOG } from './tool-catalog.js'

/**
 * The closed set of roles a process dispatches against its tool server, and
 * each one's granted tools. A role outside `roles` is granted nothing, even
 * when `grants` happens to carry an entry for it.
 */
export type ToolGrantPolicy = {
  readonly roles: readonly string[]
  readonly grants: Readonly<Record<string, readonly string[]>>
}

/** Thrown when a tool server, tool host or tool dispatch is built without its tool-grant policy. */
export class MissingToolGrantPolicyError extends Error {
  constructor(readonly builder: string) {
    super(
      `${builder}: refusing to build without its tool-grant policy (toolGrants) — a missing grant is never an empty one`
    )
    this.name = 'MissingToolGrantPolicyError'
  }
}

/** Refuses a missing or malformed policy, naming the builder that was handed it. */
export function assertToolGrantPolicy(policy: ToolGrantPolicy | undefined, builder: string): ToolGrantPolicy {
  if (
    policy === undefined ||
    policy === null ||
    !Array.isArray(policy.roles) ||
    typeof policy.grants !== 'object' ||
    policy.grants === null
  ) {
    throw new MissingToolGrantPolicyError(builder)
  }
  return policy
}

export function isGrantedRole(policy: ToolGrantPolicy, role: string): boolean {
  return policy.roles.includes(role)
}

/** The tools `role` is granted — empty for a role outside the policy's closed set. */
export function grantedTools(policy: ToolGrantPolicy, role: string): readonly string[] {
  return isGrantedRole(policy, role) ? (policy.grants[role] ?? []) : []
}

/** Whether `role` may call `tool`. A role outside the table is granted nothing. */
export function isToolGranted(policy: ToolGrantPolicy, role: string, tool: string): boolean {
  return grantedTools(policy, role).includes(tool)
}

/** The tools a dispatch of `role` is served, in catalog order: every catalog tool its grant names. */
export function servedTools(policy: ToolGrantPolicy, role: string): typeof AGENT_TOOL_CATALOG {
  return AGENT_TOOL_CATALOG.filter((tool) => isToolGranted(policy, role, tool.name))
}
