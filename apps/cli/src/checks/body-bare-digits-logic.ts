/**
 * Pure scan logic for the `body-bare-digits` check (fix/body-bare-digits).
 * No `fs`, no `git`/`gh` — the caller supplies the PR body text; every fact
 * this needs comes from that one string, so this is unit-testable with plain
 * string fixtures alone. `check-body-bare-digits.ts` is the thin wiring that
 * reads `PR_BODY` and calls this.
 *
 * The rule: a PR body may not carry a bare digit in narrative prose outside
 * a fenced/indented/inline code span. Three real false claims landed in PR
 * bodies the same day this check was written — a stale test count, an
 * unpaired "two pre-existing failures" claim, a timing figure describing
 * reverted code — none inside a verified block. This closes the position,
 * not the three specific claims: a digit that cannot exist outside a block
 * cannot be wrong in that position.
 *
 * Masking pipeline, in the order each layer depends on the one before it:
 *   1. `maskCode` — blind fenced/indented code and inline spans. Must run
 *      before `maskDetailsBlocks`: a `<details>` tag quoted in a code span
 *      must already be inert filler before the details-scanner sees it, or
 *      a decoy tag could open/close a fake region (`anchoredRegionBounds`'s
 *      PR #126 fix closed the identical decoy class for the `AEG:*`
 *      anchors).
 *   2. `maskDetailsBlocks` — blind the collapsed `<details>` block that
 *      carries the frozen, verbatim reference-brief copy
 *      (`aeg-root/templates/pr-report-template.md`: "the gates read the
 *      anchored fields above, never this block"). A pasted brief is loaded
 *      with dates, sizes, and worked examples that are quoted history, not
 *      a live claim this PR is making.
 *   3. Blank each present `AEG:*` anchor region (`anchoredRegionBounds`) —
 *      `CLOSES`/`PROJECT`/`TIER`/`PREMISE`/`TEST-PLAN` are structural
 *      fields with their own grammar, not narrative claims; `EVIDENCE`
 *      already has a dedicated freshness check (`evidence-fresh`) — this
 *      check does not re-litigate any of the six.
 *   4. Blank the `## Token report` section (heading to next heading or
 *      end-of-body) — a mandatory, un-anchored table on every PR
 *      (`aeg-root/roles/developer.md` §"Reporting exact tokens") whose
 *      cells (a task id, a raw token count) are self-reported metadata
 *      about the turn, not a claim about the code under review.
 *   5. Blank `**For:**` / `**Tier:**` / `**Project:**` header lines when
 *      not already inside their `AEG:*` anchor — the brief's mandatory
 *      "model + environment" field (`aeg-root/skills/brief-authoring/SKILL.md`
 *      §1) always names an agent/model identifier that carries a version
 *      number ("Sonnet 5", "Opus 5"), and an older, pre-anchor body writes
 *      Tier/Project bare. All three are metadata about the turn, never a
 *      claim about what the task found.
 *
 * What survives that pipeline is scanned for digit-bearing tokens, and each
 * one is classified against a fixed, named identifier-shape list (Issue/PR
 * ref, ISO date, dotted version, path segment, section/round/part ordinal,
 * inline `(N)` enumeration marker, a letter-led alphanumeric id) before
 * being counted as a real violation. Per this brief's Constraint: no shape
 * is added to that list unless it is a genuine identifier convention found
 * in this repo's own real usage — when a shape is ambiguous, it is flagged,
 * never quietly exempted.
 */

import { anchoredRegionBounds, ANCHOR_FIELDS } from '@attalabs/aeg-core'
import { maskCode, maskDetailsBlocks } from '@attalabs/aeg-forge-state/strip-code'

export type BareDigitViolation = { line: number; text: string }
export type BareDigitScanResult = { violations: BareDigitViolation[] }

/** Blanks `[start, end)` of `text`, preserving every `\n` so line numbers downstream stay correct. */
function blankRange(text: string, start: number, end: number): string {
  const region = text.slice(start, end)
  return text.slice(0, start) + region.replace(/[^\n]/g, ' ') + text.slice(end)
}

/** Blanks every present `AEG:*` anchor's outer region (markers included) — see module doc, layer 3. */
function blankAnchoredRegions(body: string): string {
  let masked = body
  for (const field of ANCHOR_FIELDS) {
    // Bounds are computed against `body` each time (never against a
    // shrinking/growing `masked`) because every blank here is same-length —
    // positions never drift, so re-deriving against the immutable original
    // is simpler than threading offset corrections, and can never
    // mis-locate a later anchor because an earlier blank moved something.
    const bounds = anchoredRegionBounds(body, field)
    if (bounds) masked = blankRange(masked, bounds.outerStart, bounds.outerEnd)
  }
  return masked
}

/**
 * Blanks the `## Token report` section: the heading line through the line
 * before the next heading (any `#`-prefixed line) or end-of-body. Heading
 * text match is case-insensitive and tolerant of `#`-level (this repo uses
 * `##`, but the check does not hard-code a level a future template edit
 * would silently break). Absent section → no-op, same additive-only
 * discipline as the `AEG:*` anchors.
 */
function blankTokenReportSection(body: string): string {
  const lines = body.split('\n')
  const HEADING = /^#{1,6}\s/
  const TOKEN_REPORT_HEADING = /^#{1,6}\s*token report\s*$/i
  const startIdx = lines.findIndex((l) => TOKEN_REPORT_HEADING.test(l))
  if (startIdx === -1) return body
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i] as string)) {
      endIdx = i
      break
    }
  }
  const fill = (line: string) => ' '.repeat(line.length)
  for (let i = startIdx; i < endIdx; i++) lines[i] = fill(lines[i] as string)
  return lines.join('\n')
}

/**
 * Blanks every line whose trimmed content starts with one of a small, fixed
 * set of bold-labeled structural fields: `**For:**` (the brief's mandatory
 * "model + environment" line — always names an agent/model identifier that
 * carries a version number, e.g. "Sonnet 5"), and `**Tier:**` / `**Project:**`
 * when NOT already inside their `AEG:*` anchor (an older, pre-anchor body
 * like #126 writes them bare) — layer 3 already blanks these when anchored,
 * so this is strictly the anchor-optional fallback, never a second pass over
 * already-blanked text.
 *
 * Scoped to exactly these three labels, not every bold field in the body: a
 * broader "any `**Label:**` line is exempt" rule would swallow a genuine
 * claim written as a field (`**Result:** 138 passed`), which this check
 * exists to catch.
 */
function blankUnanchoredStructuralFields(body: string): string {
  const lines = body.split('\n')
  const STRUCTURAL_FIELD = /^\*\*(For|Tier|Project):\*\*/
  const fill = (line: string) => ' '.repeat(line.length)
  return lines.map((l) => (STRUCTURAL_FIELD.test(l.trim()) ? fill(l) : l)).join('\n')
}

/** Full masking pipeline — see module doc for the layer order and why it's load-bearing. */
function buildScanMask(body: string): string {
  let masked = maskDetailsBlocks(maskCode(body))
  masked = blankAnchoredRegions(masked)
  masked = blankTokenReportSection(masked)
  masked = blankUnanchoredStructuralFields(masked)
  return masked
}

const ISSUE_REF = /^#\d+$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const VERSION = /^v?\d+(?:\.\d+){2,}$/i
const SECTION_SYMBOL = /^§\d+[a-z]?$/i
const INLINE_ENUM_MARKER = /^\([1-9]\d{0,2}\)$/
/** A markdown ordered-list marker's own digits: `1.` / `2)` etc. */
const LIST_MARKER_TOKEN = /^\d{1,9}[.)]$/
/**
 * This repo's own ordinal-labeling vocabulary — a fixed, closed set drawn
 * from real usage found while corpus-testing this check against
 * #126/#129/#130/#132/#136 (brief §N sections and Parts, review rounds and
 * findings, severity-labeled findings, exit codes, doc-owners failure
 * shapes, brief pre-flight steps): `Section 9`, `Round 2`, `MAJOR 1`,
 * `exit 0`, `finding 3`, `failure shape 2`, `step 4`. Never extend this by
 * guessing a word might someday precede a number — add a word only when a
 * real occurrence demands it, same discipline as a premise pin.
 *
 * Safe by construction against the opposite (quantifier) order: English
 * counts put the number FIRST with a plural noun after ("3 bugs", "138
 * tests", "6 MINOR") — that shape's digit token has the COUNTED noun as
 * its *following* word, never its preceding one, so this word-precedes-
 * number rule can't match it. Trailing `s?` only admits the plural of the
 * label itself when citing a span (`Parts 1–3`), not a counted object.
 */
const ORDINAL_WORD = /^(section|part|round|major|minor|blocker|exit|finding|shape|step)s?$/i
/** A bare ordinal after one of the words above — a single value or an `N-M`/`N–M` range (`Parts 1–3`). */
const ORDINAL_VALUE = /^\d+[a-z]?(?:[-–—]\d+[a-z]?)?$/i
/** Starts with a letter, contains at least one digit, no whitespace — an identifier (`C5`, `R1`, `claude-sonnet-5`, `round-9`), never a bare count (which starts with a digit). */
const LETTER_LED_ID = /^[A-Za-z][A-Za-z0-9.-]*\d[A-Za-z0-9.-]*$/

function stripOuterPunct(token: string): string {
  return token
    .replace(/^[(["'`*]+/, '')
    .replace(/[)\]"'`*.,;:!?]+$/, '')
    .replace(/['’]s$/i, '')
    .replace(/[)\]"'`*.,;:!?]+$/, '')
}

/**
 * Classifies one digit-bearing token found outside every masked region.
 * `precedingWord` is the previous whitespace-separated token on the same
 * (original) line, or `null` at line start — used only by the ordinal-word
 * rule above.
 */
function isExemptToken(rawToken: string, precedingWord: string | null): boolean {
  const core = stripOuterPunct(rawToken)
  if (
    ISSUE_REF.test(core) ||
    ISO_DATE.test(core) ||
    VERSION.test(core) ||
    SECTION_SYMBOL.test(core) ||
    LETTER_LED_ID.test(core)
  ) {
    return true
  }
  if (INLINE_ENUM_MARKER.test(rawToken) || LIST_MARKER_TOKEN.test(rawToken)) return true
  if (rawToken.includes('://')) return true // a URL/markdown-link locator, not a claim
  if (core.includes('/')) {
    if (/^[\w./-]+$/.test(core)) return true // a file path segment
    if (core.split('/').every((part) => SECTION_SYMBOL.test(part))) return true // `§2/§9`
  }
  // The comma guard matters: in "1 MAJOR, 6 MINOR" the word immediately
  // before "6" is "MAJOR," — adjacent only because it's the previous item
  // in a tally, not because "6" labels a "MAJOR" anything. A real label
  // pair ("Round 2", "exit 0", "MAJOR 1 —") never has a comma between the
  // word and the number; a tally's comma-separated items always do.
  if (
    precedingWord &&
    !precedingWord.endsWith(',') &&
    ORDINAL_WORD.test(stripOuterPunct(precedingWord)) &&
    ORDINAL_VALUE.test(core)
  ) {
    return true
  }
  return false
}

/**
 * A markdown ordered-list marker (`1.`/`2)`) must sit at the very start of
 * its line (≤3 leading spaces, nothing else before it) to count as a list
 * marker rather than a coincidentally dot/paren-suffixed number appearing
 * mid-sentence.
 */
function isLineLeadingListMarker(line: string, matchStart: number, rawToken: string): boolean {
  if (!LIST_MARKER_TOKEN.test(rawToken)) return false
  const before = line.slice(0, matchStart)
  return /^ {0,3}$/.test(before)
}

const TOKEN_WITH_DIGIT = /\S*\d\S*/g

/**
 * Scans `body` for bare digits outside every masked region. Returns one
 * violation per surviving digit-bearing token, in document order.
 */
export function checkBareDigits(body: string): BareDigitScanResult {
  const masked = buildScanMask(body)
  const maskedLines = masked.split('\n')
  const origLines = body.split('\n')
  const violations: BareDigitViolation[] = []

  for (let i = 0; i < maskedLines.length; i++) {
    const maskedLine = maskedLines[i] as string
    const origLine = origLines[i] as string
    TOKEN_WITH_DIGIT.lastIndex = 0
    let m: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((m = TOKEN_WITH_DIGIT.exec(maskedLine)) !== null) {
      const rawToken = origLine.slice(m.index, m.index + m[0].length)
      if (isLineLeadingListMarker(maskedLine, m.index, rawToken)) continue
      const before = origLine.slice(0, m.index).trimEnd()
      const precedingWord = before.length > 0 ? (before.split(/\s+/).pop() ?? null) : null
      if (isExemptToken(rawToken, precedingWord)) continue
      violations.push({ line: i + 1, text: origLine.trim() })
    }
  }

  return { violations }
}
