/**
 * Vinaya's Log roles: the seven names the Log attributes, each with its
 * reading in narration, its title on the agent line and whether it reviews.
 * The Log spells the security reviewer `security`; the process's role folder
 * is `security-reviewer`. Registers on import; imports nothing from Node, so
 * Mission Control's reading can bundle it.
 */

import { registerRole, registerTitle } from '@harness/kernel/log/roles'

export const VINAYA_LOG_ROLES = [
  { name: 'planner', reading: 'planner', title: 'Planner', reviews: false },
  { name: 'developer', reading: 'developer', title: 'Developer', reviews: false },
  { name: 'code-reviewer', reading: 'code reviewer', title: 'Code review', reviews: true },
  { name: 'security', reading: 'security reviewer', title: 'Security', reviews: true },
  { name: 'principal', reading: 'principal', title: 'Principal', reviews: false },
  { name: 'archivist', reading: 'archivist', title: 'Archivist', reviews: false },
  { name: 'architect', reading: 'architect', title: 'Architect', reviews: false }
] as const

/** Every Log role name Vinaya registers, in the order above. */
export const VINAYA_LOG_ROLE_NAMES: readonly string[] = VINAYA_LOG_ROLES.map((role) => role.name)

/** Registers Vinaya's Log roles and its non-role agent-line titles. Idempotent. */
export function registerVinayaLogRoles(): void {
  for (const { name, reading, title, reviews } of VINAYA_LOG_ROLES) registerRole(name, { reading, title, reviews })
  registerTitle('dev-review-loop', 'Loop')
}

registerVinayaLogRoles()
