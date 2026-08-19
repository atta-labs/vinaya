/**
 * Live derivation of `checkBlastRadiusScope`'s collision-domain list.
 *
 * The list used to be 100% hand-authored in `.aeg/packages` (see that file's
 * own header for the doctrine this module now mechanizes). Two of its three
 * sections are derivable or defaultable, and this module produces both,
 * pure — every filesystem read is injected by the caller (`open-issue.ts`),
 * so this stays testable against a literal fixture with no disk I/O.
 *
 * 1. **`packages/*` workspace domains** (`deriveWorkspacePackageDomains`) —
 *    every `package.json` `workspaces` member that resolves under `packages/`
 *    is a shared collision domain BY CONSTRUCTION (this repo's own doctrine,
 *    `.aeg/packages`'s header). A workspace member three directories deep
 *    (`packages/agents/vada-fusion`) still collapses to its top-level
 *    directory (`packages/agents`) — the domain is the directory, not the
 *    individual package, because that is the granularity every existing
 *    static list (this repo's own, attalabs') actually uses: a monorepo's
 *    `packages/agents/*` sub-packages share one collision domain, not four.
 * 2. **Built-in cross-cutting defaults** (`deriveBuiltinCrossCuttingDefaults`)
 *    — lockfile, monorepo config, CI, git hooks. Not derivable from workspace
 *    structure, but detectable by convention: presence-check a fixed
 *    candidate list rather than assuming any one of them exists.
 *
 * Neither function reads `.aeg/packages` or `vinaya.config.json`'s
 * `blastRadius.extraDomains` — those stay additive, read by the caller and
 * unioned on top (see `open-issue.ts`'s `readSharedPackages`).
 */

/**
 * Resolves a `package.json` `workspaces` entry to the workspace member
 * path(s) it names. Supports the one glob shape every package manager's
 * workspaces field actually uses in practice — a trailing `/*` naming an
 * immediate-children directory (`"packages/*"`, `"apps/*"`) — via the
 * injected `listDirs`, which the caller resolves against the real
 * filesystem. A literal entry with no trailing `/*` (attalabs' own
 * `package.json` lists every member explicitly, no globs at all) passes
 * through unchanged. Any other `*` position is not a real-world workspaces
 * shape and is dropped rather than guessed at.
 */
function resolveWorkspaceEntry(entry: string, listDirs: (dir: string) => string[]): string[] {
  if (entry.endsWith('/*')) {
    const baseDir = entry.slice(0, -2)
    return listDirs(baseDir).map((name) => `${baseDir}/${name}`)
  }
  if (entry.includes('*')) return []
  return [entry]
}

/**
 * Every `packages/*` workspace member, collapsed to its top-level directory
 * under `packages/` and deduplicated. A member outside `packages/` (an
 * `apps/*` entry, a root-level `tools/admin`) is not a `packages/*` domain
 * and is dropped — those are within a single project's own path or covered
 * by the cross-cutting defaults, never a shared-package collision domain.
 *
 * `listDirs(dir)` returns the immediate child directory NAMES of `dir`
 * (repo-relative, forward-slashed, no leading `packages/`) — the caller's
 * job is filesystem access; this function only reads its return value.
 */
export function deriveWorkspacePackageDomains(workspaces: string[], listDirs: (dir: string) => string[]): string[] {
  const domains = new Set<string>()
  for (const entry of workspaces) {
    for (const member of resolveWorkspaceEntry(entry, listDirs)) {
      const segments = member.split('/')
      if (segments[0] !== 'packages' || segments.length < 2) continue
      domains.add(`packages/${segments[1]}`)
    }
  }
  return [...domains].sort()
}

/**
 * The built-in cross-cutting candidates, in the fixed order every derived
 * list reports them — the same order the doctrine names them
 * (`aeg-root/tranche-model.md` §5) and the order attalabs' own static
 * `.aeg/packages` already lists them in, so a diff against that file reads
 * as a true empty diff rather than a reordering.
 *
 * Exactly one of the four lockfile names is expected to exist per repo — all
 * four are checked, deliberately, rather than assuming one: a repo mid-
 * migration between package managers, or one this module has never seen,
 * should still get whichever lockfile is actually on disk rather than none.
 */
export const CROSS_CUTTING_CANDIDATES = [
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'turbo.json',
  'biome.json',
  'tsconfig.json',
  '.github/workflows',
  '.husky'
] as const

/**
 * Presence-checks `CROSS_CUTTING_CANDIDATES` and returns whichever exist.
 * `exists(path)` is injected — the caller resolves it against the real
 * repo root (`existsSync(join(REPO_ROOT, path))`).
 */
export function deriveBuiltinCrossCuttingDefaults(exists: (path: string) => boolean): string[] {
  return CROSS_CUTTING_CANDIDATES.filter((path) => exists(path))
}
