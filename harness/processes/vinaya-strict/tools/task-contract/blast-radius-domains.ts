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
 *    every workspace member (from `package.json`'s `workspaces` array, or
 *    `pnpm-workspace.yaml`'s `packages:` list — pnpm does not honor a
 *    `workspaces` key in `package.json` at all, so both sources are read and
 *    combined by the caller before this function ever sees them) that
 *    resolves under `packages/` is a shared collision domain BY CONSTRUCTION
 *    (this repo's own doctrine, `.aeg/packages`'s header). A workspace member
 *    three directories deep (`packages/agents/vada-fusion`) still collapses
 *    to its top-level directory (`packages/agents`) — the domain is the
 *    directory, not the individual package, because that is the granularity
 *    every existing static list (this repo's own, attalabs') actually uses: a
 *    monorepo's `packages/agents/*` sub-packages share one collision domain,
 *    not four. A leading `!` negates an entry (npm/yarn/pnpm's own workspace
 *    negation syntax) — resolved the same way, then subtracted from the
 *    positive matches before collapsing, so an adopter's own excluded
 *    directory is never derived as a domain.
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
 * Resolves one workspace-glob entry (from either `package.json`'s
 * `workspaces` array or `pnpm-workspace.yaml`'s `packages:` list — same
 * grammar, different file) to the workspace member path(s) it names. Supports
 * the one glob shape every package manager's workspaces field actually uses
 * in practice — a trailing `/*` naming an immediate-children directory
 * (`"packages/*"`, `"apps/*"`) — via the injected `listDirs`, which the
 * caller resolves against the real filesystem. A literal entry with no
 * trailing `/*` (attalabs' own `package.json` lists every member explicitly,
 * no globs at all) passes through unchanged. Any other `*` position is not a
 * real-world workspaces shape and is dropped rather than guessed at — this
 * applies identically whether the entry came in positive or negated (the
 * caller strips the leading `!` before calling this).
 *
 * Exported so `consumer-enumeration.ts` can resolve every workspace glob
 * (`apps/*` and `packages/*` alike) rather than re-deriving this same glob
 * grammar a second time — `deriveWorkspacePackageDomains` below deliberately
 * narrows to `packages/*` only, which is wrong for that module's purpose
 * (task 10 round-2 ruling item 3).
 */
export function resolveWorkspaceEntry(entry: string, listDirs: (dir: string) => string[]): string[] {
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
 * A `!`-prefixed entry (npm/yarn/pnpm workspace negation) is resolved the
 * same way as a positive entry, and every member it resolves to is excluded
 * from the positive result BEFORE collapsing — so `["packages/*",
 * "!packages/legacy"]` never derives `packages/legacy`, but a negation that
 * excludes only one member of a many-member directory (e.g. one nested
 * package under `packages/agents`) still leaves that directory's domain
 * derived from its remaining members, which is correct: the shared directory
 * is still a real collision domain for whoever touches it.
 *
 * `listDirs(dir)` returns the immediate child directory NAMES of `dir`
 * (repo-relative, forward-slashed, no leading `packages/`) — the caller's
 * job is filesystem access; this function only reads its return value.
 */
export function deriveWorkspacePackageDomains(workspaces: string[], listDirs: (dir: string) => string[]): string[] {
  const positive = workspaces.filter((entry) => !entry.startsWith('!'))
  const negative = workspaces.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))

  const excluded = new Set<string>()
  for (const entry of negative) {
    for (const member of resolveWorkspaceEntry(entry, listDirs)) excluded.add(member)
  }

  const domains = new Set<string>()
  for (const entry of positive) {
    for (const member of resolveWorkspaceEntry(entry, listDirs)) {
      if (excluded.has(member)) continue
      const segments = member.split('/')
      if (segments[0] !== 'packages' || segments.length < 2) continue
      domains.add(`packages/${segments[1]}`)
    }
  }
  return [...domains].sort()
}

/**
 * Hand-rolled parser for `pnpm-workspace.yaml`'s `packages:` list — NOT a
 * general YAML parser, deliberately: the field is always a flat list of
 * glob/literal strings, never nested structure, so pulling in a full YAML
 * dependency for one narrow shape would be the wrong tool (same reasoning as
 * this repo's other hand-rolled parsers, e.g. `parse-registry.ts` for
 * markdown tables). Handles both forms pnpm's own docs show:
 *
 * ```yaml
 * packages:
 *   - 'packages/*'
 *   - 'apps/*'
 *   - '!packages/legacy'
 * ```
 * ```yaml
 * packages: ['packages/*', 'apps/*', '!packages/legacy']
 * ```
 *
 * Entries may be single- or double-quoted or bare; a trailing `# comment` on
 * a line is stripped. A file this cannot parse (nested anchors, multi-line
 * scalars, no `packages:` key at all) returns `[]` — the same
 * dormant-if-unreadable seam every other input to this module uses, never a
 * throw.
 */
export function parsePnpmWorkspaceYaml(content: string): string[] {
  const unquote = (s: string): string => {
    const t = s.trim()
    if (t.length >= 2 && ((t[0] === "'" && t.at(-1) === "'") || (t[0] === '"' && t.at(-1) === '"'))) {
      return t.slice(1, -1)
    }
    return t
  }

  const inlineMatch = content.match(/^packages:\s*\[(.*)\]\s*$/m)
  if (inlineMatch) {
    return (inlineMatch[1] ?? '')
      .split(',')
      .map(unquote)
      .filter((s) => s.length > 0)
  }

  const entries: string[] = []
  let inBlock = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '')
    if (/^packages:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    const itemMatch = line.match(/^\s+-\s*(.+?)\s*$/)
    if (itemMatch?.[1]) {
      entries.push(unquote(itemMatch[1]))
      continue
    }
    if (line.trim().length === 0) continue
    break // next top-level key ends the packages: block
  }
  return entries
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
