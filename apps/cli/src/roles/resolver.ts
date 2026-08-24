/**
 * The roles-side resolver — a pure function, no I/O, no `@attalabs/aeg-core`
 * import (mirrors `../checks/resolver.ts`, which itself mirrors
 * `contract.ts`'s "pure contract" discipline). The caller (`plan.ts`) reads
 * doctrine and any config-declared contract files, validates their shape
 * with `../roles/contract.ts`, and hands the already-validated results in
 * here — classification never touches a filesystem.
 *
 * `vinaya check --plan` / `--plan --json` render exactly this resolution —
 * see `../../commands/check.ts`.
 *
 * Reuses the checks resolver's namespace grammar (`isValidNamespacedKey`)
 * verbatim: same shape, same reserved `vinaya` prefix, one definition. What
 * differs from `resolveChecks` is deliberate and reviewed (frozen spec,
 * rounds 6–9): NO grace period — roles config is wholly new, with no legacy
 * population to keep warm during a warn window, so a malformed entry fails
 * closed from day one rather than degrading gracefully first. The identity
 * decoupling is also new: `name` (the registry key — what a `roles.<key>`
 * entry is addressed by) and `renderId` (the role's own `role_id` — what
 * every downstream consumer, `DiagramModel` included, actually sees) are
 * different identifiers with different jobs. For an override they happen to
 * be equal (the config key IS the core role id being replaced); for an
 * additive entry they never are (`acme/qa-lead` registers under that whole
 * namespaced key, but renders as `qa-lead`).
 */
import { isValidNamespacedKey } from '../checks/resolver'
import type { RoleContract, RoleContractValidation } from './contract'

export type RoleResolutionState = 'default' | 'overridden' | 'additive'

export type ResolvedRole = {
  /** The registry key — a core `role_id` for `default`/`overridden`, or the full namespaced config key for `additive`. */
  name: string
  state: RoleResolutionState
  source: 'core' | 'config'
  /** The role's own `role_id` — what every renderer (this table, `DiagramModel`, `vinaya doctrine --role`) actually shows. Equals `name` for `default`/`overridden`; the post-"/" segment for `additive`. */
  renderId: string
  contract: RoleContract
  /**
   * `additive` roles are documentation-only: they carry no `performs`/
   * `refuses_when` wiring into core gating (no `ACTIONS.performedBy` entry
   * exists for a render id core doctrine never declared), so a renderer
   * flags this rather than implying the role participates in enforcement.
   * Absent (never `true`) for `default`/`overridden`.
   */
  inertToGating?: true
}

export type RoleResolverFailure = { key: string; reason: string }

export type RoleResolveResult = {
  resolved: ResolvedRole[]
  failures: RoleResolverFailure[]
}

/** One config-declared role entry, already read and structurally validated by the caller. */
export type RoleConfigInput = { key: string; validation: RoleContractValidation }

/**
 * `resolved = core_registry ⊕ overridden-by-exact-key-match ⊕
 * additive-by-namespace-grammar`, exactly like `resolveChecks` — but every
 * config-declared entry must ALSO satisfy structural contract validation
 * (`validateRoleContract`, done by the caller) and a `role_id` identity
 * check specific to which class it resolves to:
 *
 *   - override: the contract's own `role_id` must equal the config key
 *     exactly (a complete replacement of the core role, never a patch — no
 *     frontmatter inheritance).
 *   - additive: the contract's own `role_id` must equal the config key's
 *     post-"/" segment exactly.
 *
 * Render-ID collisions are checked in a SECOND pass, after every additive
 * entry has been individually validated — collecting every candidate
 * render id first, then rejecting any that maps to more than one registry
 * key (additive vs. core, and additive vs. additive), so the diagnostic
 * never depends on config-file key order.
 */
export function resolveRoles(
  core: RoleContract[],
  configRoles: Record<string, RoleConfigInput> | undefined
): RoleResolveResult {
  const resolved: ResolvedRole[] = core.map((contract) => ({
    name: contract.roleId,
    state: 'default',
    source: 'core',
    renderId: contract.roleId,
    contract
  }))
  const failures: RoleResolverFailure[] = []

  if (!configRoles) return { resolved, failures }

  const indexByName = new Map(resolved.map((entry, index) => [entry.name, index]))
  const coreRoleIds = new Set(core.map((c) => c.roleId))

  type PendingAdditive = { key: string; renderId: string; contract: RoleContract }
  const pendingAdditive: PendingAdditive[] = []

  for (const [key, { validation }] of Object.entries(configRoles)) {
    const coreIndex = indexByName.get(key)

    if (coreIndex !== undefined) {
      if (!validation.ok) {
        failures.push({ key, reason: `override contract is structurally invalid: ${validation.errors.join('; ')}` })
        continue
      }
      if (validation.contract.roleId !== key) {
        failures.push({
          key,
          reason: `override contract's "role_id" ("${validation.contract.roleId}") must equal the config key ("${key}") exactly`
        })
        continue
      }
      resolved[coreIndex] = {
        name: key,
        state: 'overridden',
        source: 'config',
        renderId: validation.contract.roleId,
        contract: validation.contract
      }
      continue
    }

    if (isValidNamespacedKey(key)) {
      if (!validation.ok) {
        failures.push({ key, reason: `additive contract is structurally invalid: ${validation.errors.join('; ')}` })
        continue
      }
      const expectedRenderId = key.split('/')[1] as string
      if (validation.contract.roleId !== expectedRenderId) {
        failures.push({
          key,
          reason: `additive contract's "role_id" ("${validation.contract.roleId}") must equal the config key's post-"/" segment ("${expectedRenderId}") exactly`
        })
        continue
      }
      pendingAdditive.push({ key, renderId: validation.contract.roleId, contract: validation.contract })
      continue
    }

    failures.push({ key, reason: 'bare key has no "/" and matches no core role id' })
  }

  const ownersByRenderId = new Map<string, string[]>()
  for (const p of pendingAdditive) {
    const owners = ownersByRenderId.get(p.renderId) ?? []
    owners.push(p.key)
    ownersByRenderId.set(p.renderId, owners)
  }

  for (const p of pendingAdditive) {
    if (coreRoleIds.has(p.renderId)) {
      failures.push({
        key: p.key,
        reason: `additive role renders as "${p.renderId}", which collides with a core role id — rename this contract's own "role_id" (a future core role by that name is a documented, accepted breaking-upgrade risk, not something this resolver can prevent in advance)`
      })
      continue
    }
    const owners = (ownersByRenderId.get(p.renderId) ?? []).filter((k) => k !== p.key)
    if (owners.length > 0) {
      failures.push({
        key: p.key,
        reason: `additive role renders as "${p.renderId}", which collides with ${owners.join(', ')} — every additive role must render under a distinct "role_id"`
      })
      continue
    }
    resolved.push({
      name: p.key,
      state: 'additive',
      source: 'config',
      renderId: p.renderId,
      contract: p.contract,
      inertToGating: true
    })
  }

  return { resolved, failures }
}
