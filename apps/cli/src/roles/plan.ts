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
import { join } from 'node:path'
import { createFileDoctrineSource } from '@attalabs/vinaya-sources'
import { resolveDoctrineRoot } from '../commands/doctrine'
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
