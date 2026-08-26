/**
 * Doctrine portability — the class `check-reader-resolvable-prose` sweeps
 * but cannot see (task 234, Issue #234). That check's own module header
 * declares zero I/O, so it never resolves a cited path against a
 * filesystem — and if it tried, it would resolve against the authoring
 * repo, the one environment where every author-repo-internal path in
 * `aeg-root/**` happens to exist.
 *
 * The reframe that makes this decidable with no I/O at all: the rule is not
 * "this path does not resolve in the adopter" (which needs a filesystem to
 * even ask) but **"portable doctrine names a non-portable path."** A cited
 * path is judged purely by its own shape — its top path segment — against a
 * fixed allow-list of prefixes known to be doctrine-relative or
 * adopter-owned. Everything else is a finding, including a prefix nobody
 * has classified yet: an allow-list fails closed on an unknown prefix,
 * where a deny-list of "known author-repo prefixes" would fail open on the
 * next one (this happened once already while scoping this task —
 * `apps/cli/dist/index.js`, a build artifact, slipped past the first
 * prefix assumption because "apps/" had been read as source-only).
 *
 * Zero I/O: every input (file paths + contents) is read by the adapter and
 * passed in.
 */

export type PortabilitySourceFile = { path: string; content: string }

export type PortabilityFinding = {
  file: string
  line: number
  cited: string
  message: string
}

/** `aeg-root/**` by default — what this repo's own package ships and every adopter installs read-only. */
const DEFAULT_SHIPS_PREFIX = 'aeg-root/'

/**
 * Doctrine-relative (`roles/`, `contracts/`, `skills/`, `aeg-root/` itself)
 * and adopter-owned (`.github/`, `.vinaya/`, `.claude/`) top segments — the
 * two portable classes measured in the task-234 corpus scan. A citation
 * whose top segment falls outside this list is never assumed portable,
 * however plausible it looks; it is a finding, and someone extends this
 * list deliberately once its side of the classification is decided.
 */
const PORTABLE_PREFIXES: readonly string[] = [
  DEFAULT_SHIPS_PREFIX,
  'roles/',
  'contracts/',
  'skills/',
  '.github/',
  '.vinaya/',
  '.claude/',
  // Not in the task-234 corpus-scan table, but verified while reading the
  // corpus: `.git/hooks/*` and `.husky/*` are cited only as the pre-commit/
  // pre-push hook locations every git repo (and every husky-adopting repo)
  // genuinely has — adopter-owned by construction, the same class as
  // `.github/`/`.vinaya/`/`.claude/` above.
  '.git/',
  '.husky/'
]

/**
 * The three illustrative placeholders measured in the corpus — a
 * `[path/inside/the/...]`-shaped fill-in-the-blank in a template, never a
 * real citation. Exempted by literal, not by pattern, so a real path that
 * happens to share a prefix with one of these is never accidentally waved
 * through.
 */
const EXEMPT_LITERALS: ReadonlySet<string> = new Set([
  'path/inside/the/shipped/diff.ts',
  'path/inside/the/surface.ts',
  'apps/x/specs/...'
])

/**
 * A cited path, inline-backtick-delimited, shaped like a repo-relative
 * path: starts with a word/dot/dash character (never `/` — that shape is a
 * web route, e.g. `` `/docs/state-machine` ``, not a repo path), contains at
 * least one `/`, and carries no character a URL or a prose fragment would
 * (no `:`, no whitespace, no parens) — which also excludes a link like
 * `` `https://vinaya.dev` `` without a separate URL-shaped exclusion.
 */
const CITED_PATH_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]*)+$/

/**
 * Top segments that are never a repo path, verified against every one of
 * their occurrences in the real corpus rather than assumed: `origin/`/`refs/`
 * are git-ref namespace (`origin/main`, `refs/pull/N/merge`), and `vinaya/`/
 * `fix/` are this doctrine's own GitHub-label and branch-name-example
 * conventions (`vinaya/blocked`, `fix/brief-gate-nontask`) — a citation kind
 * this check does not judge at all, portable or not, the same way it never
 * tries to also judge a forge number or a tranche slug.
 */
const NON_PATH_TOP_SEGMENTS: ReadonlySet<string> = new Set(['origin', 'refs', 'HEAD', 'vinaya', 'fix'])

/** Every inline-backtick span in `content`, tested against `CITED_PATH_PATTERN`. */
function extractCitedPaths(content: string): { cited: string; index: number }[] {
  const found: { cited: string; index: number }[] = []
  const spanPattern = /`([^`\n]+)`/g
  let match: RegExpExecArray | null = spanPattern.exec(content)
  while (match !== null) {
    const cited = match[1] ?? ''
    const topSegment = cited.slice(0, cited.indexOf('/'))
    if (CITED_PATH_PATTERN.test(cited) && !NON_PATH_TOP_SEGMENTS.has(topSegment)) {
      found.push({ cited, index: match.index })
    }
    match = spanPattern.exec(content)
  }
  return found
}

function lineAtIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/** True iff `cited`'s top segment is one of the allow-listed portable prefixes. */
function isPortable(cited: string): boolean {
  return PORTABLE_PREFIXES.some((prefix) => cited.startsWith(prefix))
}

/**
 * Sweeps every file under `shipsPrefix` for a cited path whose top segment
 * is not allow-listed portable. Files outside `shipsPrefix` are out of
 * scope entirely — this check only judges what the shipped doctrine tree
 * itself cites, never a repo's other source.
 */
export function checkDoctrinePortability(
  files: readonly PortabilitySourceFile[],
  shipsPrefix: string = DEFAULT_SHIPS_PREFIX
): PortabilityFinding[] {
  const findings: PortabilityFinding[] = []

  for (const file of files) {
    if (!file.path.startsWith(shipsPrefix)) continue

    for (const { cited, index } of extractCitedPaths(file.content)) {
      if (EXEMPT_LITERALS.has(cited)) continue
      if (isPortable(cited)) continue
      findings.push({
        file: file.path,
        line: lineAtIndex(file.content, index),
        cited,
        message: `cites "${cited}", a path that only exists in the authoring repository — not portable doctrine`
      })
    }
  }

  return findings
}
