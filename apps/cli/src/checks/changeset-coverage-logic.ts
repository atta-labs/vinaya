/**
 * Pure predicate for the `changeset-coverage` check (Issue #258). No `fs`,
 * no `git` — every fact this needs (the fixed group's members and their
 * `package.json` `files` allowlists, the diff's changed paths, whether this
 * run is against the Changesets-release branch) is supplied by the caller,
 * so this is unit-testable with plain fixtures alone. `check-changeset-coverage.ts`'s
 * bin is the thin wiring that reads `.changeset/config.json`, resolves each
 * fixed-group member's workspace directory and `files` field, and the
 * current diff, then calls this. Mirrors `evidence-fresh-logic.ts`'s split
 * between pure decision logic and a bin's I/O.
 *
 * The predicate (brief §2, decided): a changed path counts as SHIPPED for a
 * fixed-group member iff it falls under that member's own `package.json`
 * `files` allowlist — the same "the `files` allowlist is the real ship
 * boundary" rule `vinaya-architecture` doctrine already states. A diff that
 * hits at least one shipped path and carries no `.changeset/*.md` (excluding
 * `README.md`) is a finding; the Changesets-release branch itself is exempt
 * by construction (its diff IS the changesets being consumed).
 *
 * Deliberately does NOT reuse `@attalabs/aeg-core`'s `globToRegex`: that
 * converter treats `**` as a bare `.*`, which still demands a literal `/`
 * immediately after it — so `!src/**​/*.test.ts` never matches a top-level
 * `src/foo.test.ts` (no directory between `src/` and the filename), only a
 * NESTED one. This repo's own fixed-group members put their test files
 * directly in `src/` (e.g. `packages/aeg-core/src/milestone-validation.test.ts`),
 * which is exactly the shape that quirk misses — found while writing this
 * predicate's own tests, before it ever shipped: every ordinary test-only PR
 * to a fixed-group package would have been misread as touching a SHIPPED
 * path, a false positive on the single most common diff shape this check
 * will see. `filesGlobToRegex` below gives `**​/` its standard, real-glob
 * meaning (zero-or-more path segments, optional) instead.
 */

/** One fixed-group member, as resolved live from its own `package.json` — never hardcoded. */
export type FixedGroupMember = {
  /** The published package name, e.g. `@attalabs/aeg-core`. */
  name: string
  /** Repo-relative POSIX workspace directory, e.g. `packages/aeg-core`. */
  dir: string
  /** Raw `package.json` `files` entries — positive globs and `!`-negated exclusions, matched relative to `dir`. */
  files: string[]
}

export type ChangesetCoverageResult = { status: 'pass' } | { status: 'finding'; shippedPathsHit: string[] }

function stripTrailingSlash(entry: string): string {
  return entry.endsWith('/') ? entry.slice(0, -1) : entry
}

function escapeRegexChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

/**
 * `files`-field glob grammar: `**​/` matches zero or more whole path segments
 * (so it can also match nothing — the real npm/minimatch `**` meaning), a
 * bare `**` elsewhere matches anything including `/`, a lone `*` matches
 * within one segment only, `?` matches one non-`/` character. Everything
 * else is literal.
 */
function filesGlobToRegex(pattern: string): RegExp {
  let re = '^'
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      re += '(?:.*/)?'
      i += 3
    } else if (c === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i += 2
    } else if (c === '*') {
      re += '[^/]*'
      i += 1
    } else if (c === '?') {
      re += '[^/]'
      i += 1
    } else {
      re += escapeRegexChar(c as string)
      i += 1
    }
  }
  re += '$'
  return new RegExp(re)
}

/**
 * One `files` entry matched against a path already relative to the member's
 * own dir. A bare entry (no `*`) is npm's own `files`-field semantics: it
 * matches itself exactly, or anything nested under it as a directory. A
 * `*`-bearing entry is matched as a glob via `filesGlobToRegex` above.
 */
function matchesFilesEntry(entry: string, relPath: string): boolean {
  const clean = stripTrailingSlash(entry)
  if (!clean.includes('*')) {
    return relPath === clean || relPath.startsWith(`${clean}/`)
  }
  return filesGlobToRegex(clean).test(relPath)
}

function isShippedRelPath(files: string[], relPath: string): boolean {
  const positive = files.filter((entry) => !entry.startsWith('!'))
  const negative = files.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))
  if (!positive.some((entry) => matchesFilesEntry(entry, relPath))) return false
  return !negative.some((entry) => matchesFilesEntry(entry, relPath))
}

/** `true` iff `repoRelativePath` falls under `member`'s own `files` allowlist. */
export function isShippedPath(member: FixedGroupMember, repoRelativePath: string): boolean {
  const prefix = `${stripTrailingSlash(member.dir)}/`
  if (!repoRelativePath.startsWith(prefix)) return false
  return isShippedRelPath(member.files, repoRelativePath.slice(prefix.length))
}

/** `.changeset/*.md`, excluding `.changeset/README.md` — the fixed exemption the predicate names (brief §2). */
export function isChangesetFile(repoRelativePath: string): boolean {
  return /^\.changeset\/(?!README\.md$).+\.md$/.test(repoRelativePath)
}

/**
 * The predicate itself: SHIPPED paths hit, with no `.changeset/*.md` in the
 * same diff, is a finding. `isReleaseBranch` short-circuits to `pass` before
 * either allowlist is even consulted — the Changesets-release PR's diff IS
 * the changesets being consumed, so requiring one there is incoherent.
 */
export function evaluateChangesetCoverage(
  fixedGroup: FixedGroupMember[],
  changedFiles: string[],
  isReleaseBranch: boolean
): ChangesetCoverageResult {
  if (isReleaseBranch) return { status: 'pass' }

  const shippedPathsHit = changedFiles.filter((path) => fixedGroup.some((member) => isShippedPath(member, path)))
  if (shippedPathsHit.length === 0) return { status: 'pass' }
  if (changedFiles.some(isChangesetFile)) return { status: 'pass' }

  return { status: 'finding', shippedPathsHit }
}
