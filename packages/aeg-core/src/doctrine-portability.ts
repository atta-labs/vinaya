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
 * has classified yet: an allow-list fails closed on an unknown prefix (a
 * build artifact is exactly as non-portable as the source it was built
 * from), where a deny-list of "known author-repo prefixes" would fail open
 * on the next unlisted one instead.
 *
 * **A second, additive dimension (Issue #298): a portable path is not the
 * only way doctrine couples itself to one vendor.** Prose can name a
 * specific AI company, product, or agent directly — "Claude Code", "GPT",
 * "Anthropic" — with no path shape for the path-based predicate above to
 * even look at. `checkDoctrinePortability` now emits a SECOND finding kind
 * for exactly that: a fixed vendor-name word list, scanned against prose
 * (never against code — a masked, `maskCode`-blind scan, the identical
 * code-recognition grammar `anchored-region.ts` uses for the `AEG:*` PR/Issue
 * body anchors, imported directly rather than re-implemented), with exactly
 * ONE standing exemption: text inside a `<!-- AEG:VENDOR-EXAMPLE:START -->` /
 * `<!-- AEG:VENDOR-EXAMPLE:END -->` pair — doctrine's one sanctioned, fenced
 * home for naming today's shipped reference host by product name
 * (`tranche-model.md` §12). A vendor word that is itself part of an
 * already-portable path citation (`` `.claude/hooks/x.sh` ``, `` `CLAUDE.md` ``)
 * is not re-flagged here: it is inline code, already masked by `maskCode`
 * before the word scan ever runs, and the path-shape predicate above already
 * has an opinion about it. This dimension has no I/O of its own either — same
 * inputs, same adapter.
 *
 * Zero I/O: every input (file paths + contents) is read by the adapter and
 * passed in.
 */

import { maskCode } from '@attalabs/aeg-forge-state/strip-code'

export type PortabilitySourceFile = { path: string; content: string }

export type PortabilityFinding = {
  file: string
  line: number
  cited: string
  message: string
  /** `'path'` — the original non-portable-path predicate. `'vendor-name'` — Issue #298's word-list predicate. */
  kind: 'path' | 'vendor-name'
}

/** `aeg-root/**` by default — what this repo's own package ships and every adopter installs read-only. */
const DEFAULT_SHIPS_PREFIX = 'aeg-root/'

/**
 * Doctrine-relative (`roles/`, `contracts/`, `skills/`) and adopter-owned
 * (`.github/`, `.vinaya/`, `.claude/`) top segments — the two portable
 * classes measured in the task-234 corpus scan. `aeg-root/` itself is
 * deliberately NOT a static entry here: it is always the CALLER-supplied
 * `shipsPrefix`, checked dynamically in `isPortable` below, so an adopter
 * who configures a non-default `doctrineRoot` gets that root treated as
 * portable too — a static `'aeg-root/'` entry would falsely flag every one
 * of that adopter's own self-citations as non-portable. A citation whose
 * top segment falls outside this list (and isn't the ships prefix) is
 * never assumed portable, however plausible it looks; it is a finding, and
 * someone extends this list deliberately once its side of the
 * classification is decided.
 */
const STATIC_PORTABLE_PREFIXES: readonly string[] = [
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
 *
 * **A closed, tested set, not a growable escape hatch.** Excluding a top
 * segment here means every citation under it is invisible to this check —
 * never flagged, however non-portable it would otherwise be — so this set
 * carries exactly the corpus-verified exceptions above and nothing else.
 * `doctrine-portability.test.ts` locks its exact membership; an addition
 * that doesn't also update that lock is a bug, not a silent expansion.
 * Exported for that lock, not for callers to extend at runtime.
 */
export const NON_PATH_TOP_SEGMENTS: ReadonlySet<string> = new Set(['origin', 'refs', 'HEAD', 'vinaya', 'fix'])

/**
 * The vendor-name word list (Issue #298's re-count, live at authoring):
 * every AI company/product/agent name this doctrine's own prose has
 * actually used, as either the shipped reference host or a peer example —
 * a real, hardcoded list for this repo's own corpus, not a growable
 * config surface (brief `fix/doctrine-vendor-neutrality` §10: ship a
 * reasonable hardcoded list, flag generalization for later). Longest
 * alternative first ("claude code" before "claude") so a two-word mention
 * is reported whole rather than as a truncated single-word match followed
 * by a dangling "code".
 *
 * Includes model-TIER names (`opus`/`sonnet`/`haiku`), not just
 * company/product names — a review round on this task's own PR (#338)
 * found the first cut missed exactly this class: `brief-authoring/SKILL.md`
 * and `brief-template.md` named a specific model tier bare, in prose, in
 * three places the path-shape predicate could never see either. `sonnet`
 * and `haiku` are ordinary English words outside this domain — a real
 * false-positive risk for a general-purpose tool, accepted here on the
 * same "reasonable hardcoded list for this repo's own corpus" basis as the
 * rest of this list (verified against the live corpus: no non-vendor use
 * of either word exists in `aeg-root/**` today).
 */
const VENDOR_NAME_SOURCE =
  '\\bclaude code\\b|\\bclaude\\b|\\banthropic\\b|\\bchatgpt\\b|\\bopenai\\b|\\bgpt\\b|\\bgemini\\b|\\bcodex\\b|\\bgrok\\b|\\bdeepseek\\b|\\bopus\\b|\\bsonnet\\b|\\bhaiku\\b'

/**
 * Exported (alongside `VENDOR_EXAMPLE_END` below) so `doctrine-no-procedures.ts`
 * can find the same fenced home's raw-text span — never a second copy of this
 * pattern — to exempt a fenced block that sits inside it, the same way this
 * file exempts the region from its own vendor-name word scan.
 */
export const VENDOR_EXAMPLE_START = /<!--\s*AEG:VENDOR-EXAMPLE:START\s*-->/
export const VENDOR_EXAMPLE_END = /<!--\s*AEG:VENDOR-EXAMPLE:END\s*-->/

/**
 * Blanks (same-length, index-preserving — same discipline as `maskCode`
 * itself) the region between the first well-formed
 * `<!-- AEG:VENDOR-EXAMPLE:START -->` … `<!-- AEG:VENDOR-EXAMPLE:END -->`
 * pair in `masked` — doctrine's one sanctioned home for naming today's
 * shipped reference host by product name (`tranche-model.md` §12).
 * Markers are searched on already-`maskCode`d text, the same order
 * `anchoredRegionBounds` searches the `AEG:*` PR/Issue-body anchors, so a
 * decoy pair quoted inside a fenced example never wins. A START with no
 * following END is not a fence at all — the same "malformed half-pair is no
 * anchor" rule `anchored-region.ts` applies.
 *
 * **First pair wins, same as `anchoredRegionBounds` — a SECOND pair in the
 * same file is not masked.** By design there is exactly one fenced home in
 * the whole doctrine tree (the Goal this check exists to hold), so a
 * second pair anywhere is itself a doctrine defect, not a shape this
 * function needs to accommodate; scanning per-file rather than per-pair
 * keeps that failure visible (a second, unmasked pair still reports its
 * own `vendor-name` findings) instead of silently exempting it too.
 */
function maskVendorExampleRegion(masked: string): string {
  const start = VENDOR_EXAMPLE_START.exec(masked)
  if (!start) return masked
  const afterStart = start.index + start[0].length
  const end = VENDOR_EXAMPLE_END.exec(masked.slice(afterStart))
  if (!end) return masked
  const regionEnd = afterStart + end.index + end[0].length
  const region = masked.slice(start.index, regionEnd)
  const blanked = region.replace(/[^\n]/g, ' ')
  return masked.slice(0, start.index) + blanked + masked.slice(regionEnd)
}

/**
 * Every vendor-name-list match in `content`, code-blind (`maskCode`, the
 * same grammar `anchored-region.ts` uses) and blind to the one fenced
 * `AEG:VENDOR-EXAMPLE` home. A vendor word that is only part of an
 * already-portable inline-code path citation (`` `.claude/hooks/x.sh` ``,
 * `` `CLAUDE.md` ``) never reaches this scan at all — it is masked before
 * the word list ever runs, the same way a fenced worked example is blind to
 * `body-bare-digits`.
 */
function extractVendorMentions(content: string): { name: string; index: number }[] {
  const scoped = maskVendorExampleRegion(maskCode(content))
  const found: { name: string; index: number }[] = []
  const pattern = new RegExp(VENDOR_NAME_SOURCE, 'gi')
  let match: RegExpExecArray | null = pattern.exec(scoped)
  while (match !== null) {
    found.push({ name: match[0], index: match.index })
    match = pattern.exec(scoped)
  }
  return found
}

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

/**
 * True iff `cited`'s top segment is portable: the caller-supplied
 * `shipsPrefix` itself (doctrine citing its own tree, wherever that tree
 * actually lives for this caller), or one of the static portable prefixes.
 */
function isPortable(cited: string, shipsPrefix: string): boolean {
  if (cited.startsWith(shipsPrefix)) return true
  return STATIC_PORTABLE_PREFIXES.some((prefix) => cited.startsWith(prefix))
}

/**
 * Sweeps every file under `shipsPrefix` for two independent finding kinds:
 * a cited path whose top segment is not allow-listed portable (`'path'`),
 * and a vendor-name-list word used in prose outside the one fenced
 * `AEG:VENDOR-EXAMPLE` home (`'vendor-name'`, Issue #298). Files outside
 * `shipsPrefix` are out of scope entirely — this check only judges what the
 * shipped doctrine tree itself cites/names, never a repo's other source.
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
      if (isPortable(cited, shipsPrefix)) continue
      findings.push({
        file: file.path,
        line: lineAtIndex(file.content, index),
        cited,
        message: `cites "${cited}", a path that only exists in the authoring repository — not portable doctrine`,
        kind: 'path'
      })
    }

    for (const { name, index } of extractVendorMentions(file.content)) {
      findings.push({
        file: file.path,
        line: lineAtIndex(file.content, index),
        cited: name,
        message: `names "${name}" outside the one fenced vendor-example home (an <!-- AEG:VENDOR-EXAMPLE:START --> … <!-- AEG:VENDOR-EXAMPLE:END --> pair) — portable doctrine refers to a host generically everywhere else`,
        kind: 'vendor-name'
      })
    }
  }

  return findings
}
