/**
 * The roles a process registers with the Log. The kernel holds no role of its
 * own: a process registers each Log role with its reading (narration), its
 * title (the agent line) and whether it reviews, and registers agent-line
 * titles for names that are not Log roles. A role nobody registered is not
 * attributed, and reads with the generic fallbacks.
 *
 * The registry is process-wide state. With nothing registered no role is
 * attributed. Tests save and restore it; they never clear it.
 */

export type LogRole = {
  /** How narration names the role after "the". */
  reading: string
  /** The role's title on the agent line. */
  title: string
  /** Whether narration reads a dispatch of this role as "is reviewing". */
  reviews: boolean
}

export type RoleRegistrySnapshot = {
  roles: ReadonlyMap<string, LogRole>
  titles: ReadonlyMap<string, string>
}

let roles = new Map<string, LogRole>()
let titles = new Map<string, string>()

/** Registers one Log role; a later registration of the same name replaces the earlier one. */
export function registerRole(name: string, role: LogRole): void {
  roles.set(name, role)
}

/** Registers an agent-line title for a name that is not a Log role. `isRole` never reports it. */
export function registerTitle(name: string, title: string): void {
  titles.set(name, title)
}

/** Whether the name is a registered Log role. */
export function isRole(value: string | undefined): value is string {
  return value !== undefined && roles.has(value)
}

export function lookupRole(name: string): LogRole | undefined {
  return roles.get(name)
}

/** The agent-line title registered for a name, as a Log role or as a bare title. */
export function lookupTitle(name: string): string | undefined {
  return roles.get(name)?.title ?? titles.get(name)
}

/** The registered Log role names, in registration order. */
export function registeredRoles(): string[] {
  return [...roles.keys()]
}

export function saveRoleRegistry(): RoleRegistrySnapshot {
  return { roles: new Map(roles), titles: new Map(titles) }
}

export function restoreRoleRegistry(snapshot: RoleRegistrySnapshot): void {
  roles = new Map(snapshot.roles)
  titles = new Map(snapshot.titles)
}
