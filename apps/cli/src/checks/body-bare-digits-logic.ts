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
 *
 * Known, accepted limitation (security review round 3, live on this task —
 * flagged, not silently shipped): the ordinal-word exemption's disqualifying
 * lookahead (`hasDisqualifyingCountNoun`) checks the following words against
 * `COUNT_NOUN`, a closed, named vocabulary — not a general English noun
 * classifier. A narrative claim using a count noun outside that vocabulary
 * ("step 200 tickets were closed", "round 5000 outages occurred") still
 * launders past the exemption. Rounds 1 and 2 patched this same laundering
 * class twice (a plural-suffix regex, then closed-vocabulary + bracket/
 * article handling); round 3 proved a closed vocabulary is fundamentally
 * incomplete by construction, not merely under-populated — no finite list
 * closes an open-ended one. Recognizing "is this word the object a number
 * is quantifying" in full generality is a real natural-language-grammar
 * problem, not a solvable regex-heuristic one; continuing to patch
 * individual escaped words here would repeat the exact whack-a-mole this
 * comment exists to stop. The Principal has this open for a structural
 * redesign decision (a real NLP/POS dependency, or narrowing what the
 * ordinal-word exemption recognizes in the first place, are two live
 * options) rather than a fourth vocabulary patch.
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

// `\p{Nd}` (Unicode "decimal digit number"), not `\d` — round 3 security
// review found `\d`'s ASCII-only match let a fullwidth-digit claim
// ("１３８ tests passed", U+FF10-FF19) bypass the scanner ENTIRELY: not an
// exemption gap, a detection gap — the token never even became a
// candidate. Every regex in this file that recognizes a digit shape uses
// `\p{Nd}` (`u` flag) for the same reason, from here through
// `LETTER_LED_ID` and `TOKEN_WITH_DIGIT` below.
const ISSUE_REF = /^#\p{Nd}+$/u
const ISO_DATE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u
const VERSION = /^v?\p{Nd}+(?:\.\p{Nd}+){2,}$/iu
const SECTION_SYMBOL = /^§\p{Nd}+[a-z]?$/iu
const INLINE_ENUM_MARKER = /^\([1-9]\p{Nd}{0,2}\)$/u
/** A markdown ordered-list marker's own digits: `1.` / `2)` etc. */
const LIST_MARKER_TOKEN = /^\p{Nd}{1,9}[.)]$/u
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
 * additionally requires `hasDisqualifyingCountNoun` to find nothing after
 * the digit before this exemption applies — see that check for why "the
 * countable noun always follows, never precedes" was the wrong invariant
 * to rely on alone.
 */
const ORDINAL_WORD = /^(section|part|round|major|minor|blocker|exit|finding|shape|step)s?$/i
/** A bare ordinal after one of the words above — a single value or an `N-M`/`N–M` range (`Parts 1–3`). */
const ORDINAL_VALUE = /^\p{Nd}+[a-z]?(?:[-–—]\p{Nd}+[a-z]?)?$/iu
/**
 * The closed, domain-specific vocabulary of things a PR body would
 * plausibly report a count of — singular AND plural, since a singular
 * count noun launders exactly as well as a plural one ("step 200 test
 * failed" is just as fabricatable as "step 200 tests failed"; round 2
 * security review finding). Deliberately a closed list, not a suffix
 * heuristic (round 1 shipped `/^[a-z]{3,}(?<![su])s$/i`, an attempt to
 * detect "looks plural" — round 2 found it: (a) never matches a singular
 * noun at all, and (b) still isn't what "is this word a countable-claim
 * noun" actually means, since plenty of non-count words end in a bare
 * `s` too. A closed list is auditable by inspection instead. Extend it
 * only when a real occurrence demands it, same discipline as a premise
 * pin — the words below are exactly what two adversarial security rounds
 * demonstrated escaping (test, regression, bug, request, defect) plus
 * their obvious close relatives.
 */
const COUNT_NOUN =
  /^(tests?|regressions?|bugs?|requests?|defects?|errors?|failures?|issues?|warnings?|crash(?:es)?|vulnerabilit(?:y|ies))$/i
/** Starts with a letter, ends in a run of digits (optionally dotted) with no letters after — an identifier (`C5`, `R1`, `claude-sonnet-5`, `round-9`), never a claim glued to a hyphenated phrase (`Fixed-42-bugs-in-this-pass`, which ends in letters, not digits). */
const LETTER_LED_ID = /^[A-Za-z][A-Za-z-]*\p{Nd}[\p{Nd}.]*$/u

// Unicode curly quotes alongside their ASCII equivalents — round 3 security
// review found a count noun wrapped in curly quotes ('step 200 "tests"
// failed') evaded every strip pass here the same way the round-2 ASCII-`(`
// bypass did; a smart-quoting editor produces these routinely, not just an
// adversarial input.
function stripOuterPunct(token: string): string {
  return token
    .replace(/^[(["'`*“”‘’]+/, '')
    .replace(/[)\]"'`*.,;:!?“”‘’]+$/, '')
    .replace(/['’]s$/i, '')
    .replace(/[)\]"'`*.,;:!?“”‘’]+$/, '')
}

/** Articles/prepositions that don't themselves carry the claim — skipped, not counted, when looking for the noun after them ("step 200 of the tests failed"; round 2 security review finding). */
const FUNCTION_WORD = /^(of|the|a|an|in|on|at|to|for|with|by)$/i

/**
 * Does a `COUNT_NOUN` appear among the (up to) four CONTENT words following
 * the digit? Reads raw words in order, skipping `FUNCTION_WORD`s without
 * spending the content-word budget on them (closes round 2 finding 3's
 * preposition-separated escape), and unwraps a single layer of
 * parens/brackets via the same `stripOuterPunct` every other classification
 * uses rather than treating an opening bracket as an automatic pass
 * (closes round 2 finding 2's `(tests)`/`[regressions]` escape — the round
 * 1 code special-cased `raw.startsWith('(')` to `return false` immediately,
 * which is exactly the hole: it never even looked at the word inside).
 *
 * Budget widened 2 → 4 (round 3 security review finding 4): a two-word
 * budget only skipped FUNCTION_WORDs for free, so any OTHER filler word
 * ("total", "number") still spent it, letting a noun four words out
 * escape ("step 200 of the total number of tests failed" — "of"/"the"
 * skip free, but "total"/"number" burn the whole budget before "tests"
 * is ever reached). Four is a width, not a word list — it does not add
 * another special case to chase, it makes the existing one reach a
 * little further; `COUNT_NOUN` finding 1's fundamental incompleteness is
 * the one the budget itself can't fix, see this file's module doc.
 */
function hasDisqualifyingCountNoun(followingWords: string[]): boolean {
  let checked = 0
  for (const raw of followingWords) {
    const core = stripOuterPunct(raw)
    if (FUNCTION_WORD.test(core)) continue
    if (checked >= 4) break
    checked++
    if (COUNT_NOUN.test(core)) return true
  }
  return false
}

/**
 * Classifies one digit-bearing token found outside every masked region.
 * `precedingWord` is the previous whitespace-separated token on the same
 * (original) line, or `null` at line start. `followingWords` are the
 * whitespace-separated tokens after this one (the caller passes a handful
 * — `hasDisqualifyingCountNoun` skips function words within that budget
 * without spending its own two-content-word limit on them) — both used
 * only by the ordinal-word rule below.
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
  // The count-noun lookahead matters just as much, and independently: a
  // preceding label word is necessary but not sufficient (security review,
  // this task — see COUNT_NOUN's doc comment for the empirical proof).
  // "step 200 tests" has the identical preceding-word shape as "exit 0 on
  // success"; only checking what follows the number tells them apart.
  if (
    precedingWord &&
    !precedingWord.endsWith(',') &&
    ORDINAL_WORD.test(stripOuterPunct(precedingWord)) &&
    ORDINAL_VALUE.test(core) &&
    !hasDisqualifyingCountNoun(followingWords)
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

// `\p{Nd}`, not `\d` — this is the base candidate-detection regex; every
// other Unicode fix in this file is downstream of getting THIS one right,
// since a token this never matches is never even classified (round 3
// security review, the most severe of the three findings that round
// produced).
const TOKEN_WITH_DIGIT = /\S*\p{Nd}\S*/gu

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
      // 6 raw tokens, not 2 — `hasDisqualifyingCountNoun` skips function
      // words (of/the/a/…) without spending its own two-content-word
      // budget on them, so it needs room past them in the raw slice.
      const followingWords = after.length > 0 ? after.split(/\s+/).slice(0, 12) : []
      if (isExemptToken(rawToken, precedingWord, followingWords)) continue
      violations.push({ line: i + 1, text: origLine.trim() })
    }
  }

  return { violations }
}
