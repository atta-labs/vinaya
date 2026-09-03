/**
 * `checkConsumerTests`'s consumer enumeration (`brief-validation.ts`, task 10,
 * Issue #385; corrected by the round-2 ruling item 3) — every workspace
 * member whose own `package.json` depends on `@attalabs/<pkg>`, for "every
 * workspace package depending on `@attalabs/<pkg>`" to mean what it says.
 *
 * The first cut reused `deriveWorkspacePackageDomains` (`blast-radius-domains.ts`),
 * which deliberately collapses to `packages/*` members only — correct for
 * that module's own collision-domain purpose, wrong here: it silently
 * exempted `apps/cli`, a real `@attalabs/aeg-core` consumer, from a rule
 * that promises "every workspace package" (found live reviewing this PR's
 * own diff). This module resolves every workspace glob instead —
 * `apps/*` and `packages/*` alike — via `resolveWorkspaceEntry`, the same
 * glob grammar `deriveWorkspacePackageDomains` uses, reused rather than
 * re-derived a second time.
 *
 * Zero I/O: `listDirs`/`readManifest` are injected by each of the two real
 * entry points — `packages/aeg-core/bin/verify-brief.ts` (authoring-time,
 * pre-dispatch) and `apps/cli`'s `check-brief-shape.ts` (CI) — so both share
 * ONE enumeration rather than two independently-maintained copies that can
 * silently diverge (round-2 ruling item 4).
 */

import { resolveWorkspaceEntry } from './blast-radius-domains'

export type PackageManifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/**
 * Every workspace member directory (`apps/cli`, `packages/aeg-core`, …),
 * resolved from `workspaces` (positive entries minus any `!`-negated ones,
 * same semantics as `deriveWorkspacePackageDomains`) — but NOT collapsed to
 * `packages/*` only, since a real consumer can live anywhere in the
 * workspace.
 */
export function deriveWorkspaceMemberDirs(workspaces: string[], listDirs: (dir: string) => string[]): string[] {
  const positive = workspaces.filter((entry) => !entry.startsWith('!'))
  const negative = workspaces.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))

  const excluded = new Set<string>()
  for (const entry of negative) {
    for (const member of resolveWorkspaceEntry(entry, listDirs)) excluded.add(member)
  }

  const members = new Set<string>()
  for (const entry of positive) {
    for (const member of resolveWorkspaceEntry(entry, listDirs)) {
      if (!excluded.has(member)) members.add(member)
    }
  }
  return [...members].sort()
}

/**
 * Builds `checkConsumerTests`'s `consumersOf` callback: for a package `pkg`
 * (as named in a brief's `§4`, e.g. `packages/aeg-core/` → `'aeg-core'`),
 * every workspace member directory (self excluded) whose own manifest lists
 * `@attalabs/<pkg>` in `dependencies` or `devDependencies`.
 */
export function buildConsumersOf(
  workspaces: string[],
  listDirs: (dir: string) => string[],
  readManifest: (dir: string) => PackageManifest | null
): (pkg: string) => string[] {
  const members = deriveWorkspaceMemberDirs(workspaces, listDirs)

  return (pkg: string): string[] => {
    const target = `@attalabs/${pkg}`
    return members.filter((dir) => {
      if (dir === `packages/${pkg}`) return false
      const manifest = readManifest(dir)
      if (!manifest) return false
      return target in (manifest.dependencies ?? {}) || target in (manifest.devDependencies ?? {})
    })
  }
}
