/**
 * I/O boundary for the roles half of `vinaya check --plan` — the thin shim
 * that reads doctrine (through the `DoctrineSource` seam) and any
 * config-declared contract files, then hands already-validated data to the
 * pure `resolveRoles` (`./resolver.ts`). Mirrors `../commands/check.ts`'s
 * own split: I/O here, classification there.
 *
 * Doctrine is read through `@attalabs/vinaya-sources`'s
 * `createFileDoctrineSource`, rooted at `resolveDoctrineRoot()` — the same
 * install-aware resolution `vinaya doctrine` uses (bundled-package shape
 * first, vendored-monorepo fallback second) — never a bare `"aeg-root"`
 * relative to cwd, which is only correct inside this monorepo itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extractShortVersionAndChecklist } from '@attalabs/aeg-core/docs'
import { createFileDoctrineSource } from '@attalabs/vinaya-sources'
import { resolveDoctrineRoot } from '../commands/doctrine'
import { configPath, loadConfigChecked } from '../lib/config'
import type { RoleEntry } from '../lib/config'
import { type RoleContract, validateRoleContract } from './contract'
import { type ResolvedRole, type RoleConfigInput, type RoleResolverFailure, resolveRoles } from './resolver'

export type RolePlan =
  | { available: true; resolved: ResolvedRole[]; failures: RoleResolverFailure[] }
  | { available: false; reason: string }

const NO_DOCTRINE_REASON =
  "no bundled doctrine found next to this CLI install — the doctrine ships inside the @attalabs/vinaya npm package. Reinstall it, or, in a repo that vendors the CLI, run the package's bundle-doctrine script first."

/**
 * Reads and structurally validates one config-declared role's contract
 * file, resolved relative to `configDir` — the directory the repo-local
 * `vinaya.config.json` was found in (a `roles` entry only ever reaches
 * here from that file; `roles` is stripped from a global config at load
 * time, see `../lib/config.ts`).
 */
function readContract(configDir: string, contractPath: string): ReturnType<typeof validateRoleContract> {
  const absolute = join(configDir, contractPath)
  if (!existsSync(absolute)) {
    return { ok: false, errors: [`contract file "${contractPath}" does not exist (resolved to "${absolute}")`] }
  }
  try {
    return validateRoleContract(readFileSync(absolute, 'utf-8'))
  } catch (err) {
    return { ok: false, errors: [`could not read "${contractPath}": ${(err as Error).message}`] }
  }
}

/**
 * Builds the roles half of `--plan`: `available: false` with a reason when
 * no bundled doctrine can be found (nothing to resolve against — the same
 * refusal `vinaya doctrine` itself reports), else the full `resolveRoles`
 * result over core doctrine roles plus every config-declared entry.
 *
 * `configDir` is the repo-local `vinaya.config.json`'s own directory
 * (`null` when no local config exists) — required to resolve a `roles.<key>.contract`
 * path; `configRoles` is that config's own `roles` field, verbatim.
 */
export async function buildRolePlan(
  configDir: string | null,
  configRoles: Record<string, RoleEntry> | undefined
): Promise<RolePlan> {
  const root = resolveDoctrineRoot()
  if (root === null) return { available: false, reason: NO_DOCTRINE_REASON }

  const doctrine = await createFileDoctrineSource({ root }).getDoctrine()
  const core: RoleContract[] = []
  for (const file of doctrine.roles) {
    const validation = validateRoleContract(file.content)
    // Core doctrine is already gated by `packages/aeg-core/bin/verify-registry.ts`'s
    // own G5 check — a structurally invalid core file here would be a
    // doctrine bug, not a config error, and is silently excluded rather
    // than surfaced as a `roles` resolution failure (the same precedent
    // `deriveDiagramModel`'s own `extractRole` sets for a role file
    // missing `role_id`).
    if (validation.ok) core.push(validation.contract)
  }

  let configInput: Record<string, RoleConfigInput> | undefined
  if (configRoles && Object.keys(configRoles).length > 0) {
    configInput = {}
    for (const [key, entry] of Object.entries(configRoles)) {
      const validation = configDir
        ? readContract(configDir, entry.contract)
        : {
            ok: false as const,
            errors: ['no repo-local vinaya.config.json directory to resolve this contract path against']
          }
      configInput[key] = { key, validation }
    }
  }

  return { available: true, ...resolveRoles(core, configInput) }
}

/**
 * The published role doctrine — short version plus `## What you check` — for a
 * dispatched review pass, resolved through the SAME role plan `vinaya check
 * --plan` renders (O2): an overridden reviewer/security role supplies the
 * override's own body, a default role the core body. `'reviewer'` here is the
 * doctrine role id `code-reviewer` resolves to (the dispatch's own alias — see
 * `../commands/doctrine.ts`'s `ROLE_ALIASES`).
 *
 * Reads the repo-local config the same way `check.ts` does, so an adopter's
 * `roles` override is honoured. Returns `null` when no doctrine can be
 * resolved (no bundled doctrine, or the role is absent from the plan) — the
 * caller then dispatches without the injected doctrine rather than failing the
 * round, exactly the pre-task behaviour.
 */
export async function resolveRoleDoctrineText(role: 'reviewer' | 'security'): Promise<string | null> {
  const configResult = loadConfigChecked()
  const configFilePath = configResult.ok ? configPath() : configResult.path
  const plan = await buildRolePlan(
    configFilePath ? dirname(configFilePath) : null,
    configResult.ok ? configResult.config?.roles : undefined
  )
  if (!plan.available) return null
  const resolved = plan.resolved.find((entry) => entry.renderId === role)
  if (resolved === undefined) return null
  return extractShortVersionAndChecklist(resolved.contract.body)
}

/**
 * Which FILE `vinaya doctrine --role <renderId>` serves, resolved through the
 * SAME role plan the review loop uses (`resolveRoleDoctrineText` above, O3):
 * a `default` role is served from `<doctrine-root>/roles/<role_id>.md`; an
 * `overridden` or `additive` role from its config-declared contract file. The
 * command reads whatever file this returns — so an override's own frontmatter
 * (read-receipt token and all) and body reach `--print` unchanged, and an
 * additive role is served instead of reported unknown (O1, O2).
 *
 * Returns the file path plus the servable role names (the plan's render ids,
 * `actor: 'human'` roles excluded — `--role`'s output is handed to an agent
 * tool as operating instructions, so `principal` must never resolve through it,
 * the same structured exclusion `listRoleNames` applied before this resolver).
 * `found: false` carries the same `validNames` so the command's "not a known
 * role" refusal lists overrides and additives too. `available: false` mirrors
 * `buildRolePlan`'s own no-doctrine refusal.
 */
export type RoleFileResolution =
  | { available: false; reason: string }
  | { available: true; found: false; validNames: string[] }
  | { available: true; found: true; path: string; validNames: string[] }

export async function resolveRoleFile(renderId: string): Promise<RoleFileResolution> {
  const root = resolveDoctrineRoot()
  if (root === null) return { available: false, reason: NO_DOCTRINE_REASON }

  const configResult = loadConfigChecked()
  const configFilePath = configResult.ok ? configPath() : configResult.path
  const configDir = configFilePath ? dirname(configFilePath) : null
  const configRoles = configResult.ok ? configResult.config?.roles : undefined

  const plan = await buildRolePlan(configDir, configRoles)
  if (!plan.available) return { available: false, reason: plan.reason }

  const servable = plan.resolved.filter((entry) => entry.contract.actor !== 'human')
  const validNames = servable.map((entry) => entry.renderId).sort()

  const match = servable.find((entry) => entry.renderId === renderId)
  if (match === undefined) return { available: true, found: false, validNames }

  // A `default` role's file is the core `<root>/roles/<role_id>.md` — the exact
  // path the command computed before this resolver existed (core doctrine
  // guarantees the filename equals the `role_id`).
  if (match.source === 'core') {
    return { available: true, found: true, path: join(root, 'roles', `${match.renderId}.md`), validNames }
  }

  // An `overridden`/`additive` role is served from its config contract,
  // resolved relative to the repo-local config's directory. `match.name` is
  // that config's own key, and a config-sourced entry only ever reaches
  // `resolved` when that directory and entry were present — the guard below is
  // defensive for the type-checker, never a reachable branch.
  const entry = configRoles?.[match.name]
  if (configDir === null || entry === undefined) return { available: true, found: false, validNames }
  return { available: true, found: true, path: join(configDir, entry.contract), validNames }
}
