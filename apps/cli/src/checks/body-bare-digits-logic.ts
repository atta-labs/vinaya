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
 * set of structural fields — plain (`Tier: 1`) or bold (`**Tier:** 1`), both
 * accepted by this repo's own Tier grammar
 * (`aeg-root/roles/developer.md` § PR body — canonical form): `For:` (the
 * brief's mandatory "model + environment" line — always names an
 * agent/model identifier that carries a version number, e.g. "Sonnet 5"),
 * and `Tier:` / `Project:` when NOT already inside their `AEG:*` anchor (an
 * older, pre-anchor body like #126 writes them bare, and `vinaya demo`'s own
 * fixture PR body writes a plain, unbolded `Tier: 1`) — layer 3 already
 * blanks these when anchored, so this is strictly the anchor-optional
 * fallback, never a second pass over already-blanked text.
 *
 * Scoped to exactly these three labels, not every field in the body: a
 * broader "any `Label:` line is exempt" rule would swallow a genuine claim
 * written as a field (`Result: 138 passed`), which this check exists to
 * catch.
 */
function blankUnanchoredStructuralFields(body: string): string {
  const lines = body.split('\n')
  const STRUCTURAL_FIELD = /^\*{0,2}(For|Tier|Project):\*{0,2}/
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
 * NOT safe on its own against a countable-noun follower — a preceding label
 * word is necessary but not sufficient: "step 200 tests", "round 5000
 * regressions", "shape 12345 requests" all match this word-precedes-number
 * shape exactly as "Round 2"/"exit 0" do, but are genuine claims, not
 * labels (round 1 security review finding). The `isExemptToken` caller
 * additionally requires `PLURAL_NOUNISH` to find nothing in the two words
 * following the digit before this exemption applies — see that check for
 * why "the countable noun always follows, never precedes" was the wrong
 * invariant to rely on alone.
 */
const ORDINAL_WORD = /^(section|part|round|major|minor|blocker|exit|finding|shape|step)s?$/i
/** A bare ordinal after one of the words above — a single value or an `N-M`/`N–M` range (`Parts 1–3`). */
const ORDINAL_VALUE = /^\d+[a-z]?(?:[-–—]\d+[a-z]?)?$/i
/**
 * A word ending in a single, un-doubled, non-`-us` `s` — the surface shape
 * of an English plural count noun ("tests", "regressions", "bugs",
 * "requests"). The `(?<![su])` guard excludes "-ss"/"-us" endings that are
 * NOT plurals (`success`, `process`, `access`, `focus`, `status`) — words
 * that legitimately follow a label in this repo's own real usage ("exit 0
 * on success"). Minimum length 4 additionally excludes short function
 * words that happen to end in `s` ("was", "his", "as") from ever matching
 * at all, since `[a-z]{3,}` alone already requires 4+ total characters
 * once the trailing literal `s` is counted separately.
 *
 * Round 1 security review (this task, live): confirmed empirically that
 * `ORDINAL_WORD` + `ORDINAL_VALUE` alone let "step 200 tests", "round 5000
 * regressions", "Finding 999 critical bugs", "shape 12345 requests", and
 * "exit 42 tests" all escape as non-violations — the shipped guard only
 * covered the comma-adjacent-tally variant of this same laundering, never
 * plain word-adjacency. This is the fix: a plural noun within the two
 * words following the digit disqualifies the label reading regardless of
 * what precedes it.
 */
const PLURAL_NOUNISH = /^[a-z]{3,}(?<![su])s$/i
/** Starts with a letter, ends in a run of digits (optionally dotted) with no letters after — an identifier (`C5`, `R1`, `claude-sonnet-5`, `round-9`), never a claim glued to a hyphenated phrase (`Fixed-42-bugs-in-this-pass`, which ends in letters, not digits). */
const LETTER_LED_ID = /^[A-Za-z][A-Za-z-]*\d[\d.]*$/

function stripOuterPunct(token: string): string {
  return token
    .replace(/^[(["'`*]+/, '')
    .replace(/[)\]"'`*.,;:!?]+$/, '')
    .replace(/['’]s$/i, '')
    .replace(/[)\]"'`*.,;:!?]+$/, '')
}

/** A coordinating conjunction — starts a new clause, so nothing past it still describes the number. */
const CLAUSE_CONJUNCTION = /^(and|or|but|nor)$/i

/**
 * Scans `followingWords` in order for a disqualifying plural-count-noun,
 * but stops at the first clause boundary — a raw word opening with `(`/`[`
 * (a parenthetical aside), or a coordinating conjunction — without
 * examining it or anything past it. A word beyond that boundary describes
 * something else, not the number ("failure shape 2 (globs technically
 * alive...)" — "globs" never modifies "2"; "exit 0 and sends a signal" —
 * "sends" is a new clause's verb, not a plural noun counting "0"). Both
 * are real corpus false-positives this boundary check closes (found while
 * re-verifying the security round 1 fix against #126/#136's real bodies).
 */
function hasDisqualifyingPluralNoun(followingWords: string[]): boolean {
  for (const raw of followingWords) {
    if (raw.startsWith('(') || raw.startsWith('[')) return false
    const core = stripOuterPunct(raw)
    if (CLAUSE_CONJUNCTION.test(core)) return false
    // A following word that is ITSELF an ordinal-word (`Parts 1–3 and
    // Section 9` — "Section" right after a range) is the start of the
    // NEXT label, not a disqualifying countable noun.
    if (PLURAL_NOUNISH.test(core) && !ORDINAL_WORD.test(core)) return true
  }
  return false
}

/**
 * Classifies one digit-bearing token found outside every masked region.
 * `precedingWord` is the previous whitespace-separated token on the same
 * (original) line, or `null` at line start. `followingWords` are the next
 * up to two whitespace-separated tokens after this one, or `[]` at line
 * end — both used only by the ordinal-word rule below.
 */
function isExemptToken(rawToken: string, precedingWord: string | null, followingWords: string[]): boolean {
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
    // A slash-separated list of identifiers cited together (`§2/§9`,
    // `#126/#129/#130`) — every part must independently be an identifier
    // shape, not just the first, or a real claim glued to a real ref by a
    // stray slash would slip through on the ref's coattails.
    if (core.split('/').every((part) => SECTION_SYMBOL.test(part) || ISSUE_REF.test(part))) return true
  }
  // The comma guard matters: in "1 MAJOR, 6 MINOR" the word immediately
  // before "6" is "MAJOR," — adjacent only because it's the previous item
  // in a tally, not because "6" labels a "MAJOR" anything. A real label
  // pair ("Round 2", "exit 0", "MAJOR 1 —") never has a comma between the
  // word and the number; a tally's comma-separated items always do.
  //
  // The plural-noun lookahead matters just as much, and independently: a
  // preceding label word is necessary but not sufficient (security review,
  // this task — see PLURAL_NOUNISH's doc comment for the empirical proof).
  // "step 200 tests" has the identical preceding-word shape as "exit 0 on
  // success"; only checking what follows the number tells them apart.
  if (
    precedingWord &&
    !precedingWord.endsWith(',') &&
    ORDINAL_WORD.test(stripOuterPunct(precedingWord)) &&
    ORDINAL_VALUE.test(core) &&
    !hasDisqualifyingPluralNoun(followingWords)
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
      const after = origLine.slice(m.index + m[0].length).trim()
      const followingWords = after.length > 0 ? after.split(/\s+/).slice(0, 2) : []
      if (isExemptToken(rawToken, precedingWord, followingWords)) continue
      violations.push({ line: i + 1, text: origLine.trim() })
    }
  }

  return { violations }
}
