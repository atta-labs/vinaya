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
 * Structural fix (security review round 4; the Principal's direction after
 * round 3 proved a closed vocabulary is fundamentally incomplete by
 * construction, not under-populated — "stop patching individual cases,
 * rethink the exemption's detection strategy structurally"): the
 * ordinal-word exemption's disqualifying lookahead
 * (`hasDisqualifyingClaim`) is no longer vocabulary-only. It unions two
 * independent signals, each covering ground the other structurally can't —
 *   (a) `COUNT_NOUN`, a named vocabulary — still the full breadth rounds
 *       1–3 demonstrated, because it alone is what BRACKETED content is
 *       checked against (`(tests)`, `[regressions]`): grammar adjacency is
 *       deliberately never extended across a parenthetical (see below),
 *       so a bracket-wrapped noun only stays caught here. It is also the
 *       backstop for words `compromise`'s default model mis-tags
 *       ambiguously with no sentence context ("test"/"bug" read as verbs
 *       almost as often as nouns) and for a compound noun whose head sits
 *       one modifier word from the digit ("support tickets" — grammar's
 *       adjacency requirement can't reach past "support"); and
 *   (b) a real grammar check (`compromise`, a POS tagger,
 *       `hasDisqualifyingClaim`) asking whether the digit is immediately
 *       (`^`-anchored) followed by a tagged noun — a structural, not
 *       enumerable, signal for OPEN, unbracketed adjacency: it generalizes
 *       to any English count noun ("outages", "incidents", "people"),
 *       closing round 3's actual complaint (finding 1) for the common case
 *       rather than adding three more words to a list a fifth round would
 *       just find the next gap in.
 * Both signals are deliberately narrow in ways that matter: grammar
 * adjacency never crosses a parenthetical (protects real, required-clean
 * list items like `**exit 0** (pass)` from reading the aside as "0"'s
 * object), the grammar match is anchored to the digit itself and not just
 * "found somewhere in the clause" (protects against an unrelated LATER
 * number+noun pair in a long sentence being misattributed to an earlier
 * one — found live against #136's own body), and `COUNT_NOUN`'s own
 * lookahead stays word-budget-bounded rather than clause-unbounded (an
 * unbounded scan was tried and reverted — it reached six words into a
 * different real #136 sentence and flagged a required-clean label; see
 * `hasDisqualifyingClaim`'s doc). That budget remains beatable by a long
 * enough filler chain (round 4 finding 5) — a narrower, honestly
 * documented residual than finding 1 ever was, not a reopened one.
 */

import { anchoredRegionBounds, ANCHOR_FIELDS } from '@attalabs/aeg-core'
import { maskCode, maskDetailsBlocks } from '@attalabs/aeg-forge-state/strip-code'
import nlp from 'compromise'

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
 * additionally requires `hasDisqualifyingClaim` to find nothing after
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
 * security review finding).
 *
 * Round 4 added a real grammar check (`hasDisqualifyingClaim`'s `#Value+
 * #Noun+` match) as the PRIMARY signal for open, unbracketed adjacency —
 * this list no longer has to anticipate every English count noun for that
 * case, only the words compromise's own tagger gets wrong standalone
 * ("test"/"bug" — read as a verb as often as a noun with no sentence
 * context) and "ticket" (a compound-noun gap, see `hasDisqualifyingClaim`'s
 * doc). But grammar adjacency is deliberately never extended across a
 * parenthetical — `(pass)` after "exit 0" is a real, required-clean status
 * note, not a claim about "0", and a tagger can't tell that case apart
 * from `(tests)` genuinely counting a redundantly-parenthesized claim by
 * bracket shape alone. This list is what BRACKETED content is checked
 * against instead (`stripOuterPunct` already unwraps a single bracket
 * layer before testing), which is why it still needs the full breadth
 * rounds 1–3 demonstrated escaping, not just the two grammar-blind-spot
 * words — `(tests)`/`[regressions]` (round 2 finding 2) only stay caught
 * because this list, not the grammar check, is what sees inside them.
 * Extend only when a real occurrence demands it, same discipline as a
 * premise pin.
 */
const COUNT_NOUN =
  /^(tests?|regressions?|bugs?|requests?|defects?|errors?|failures?|issues?|warnings?|crash(?:es)?|vulnerabilit(?:y|ies)|tickets?)$/i
/** Starts with a letter, ends in a run of digits (optionally dotted) with no letters after — an identifier (`C5`, `R1`, `claude-sonnet-5`, `round-9`), never a claim glued to a hyphenated phrase (`Fixed-42-bugs-in-this-pass`, which ends in letters, not digits). */
const LETTER_LED_ID = /^[A-Za-z][A-Za-z-]*\p{Nd}[\p{Nd}.]*$/u

// Zero-width and other Unicode default-ignorable characters — security
// review round 4 found one embedded inside an otherwise-recognized count
// noun ("te" + U+200B + "sts") defeats every regex classification in this
// file regardless of vocabulary completeness, a stronger bypass than any
// single word gap: "not an incomplete word list, a way to defeat any word
// list this file will ever have." Stripped from the WHOLE body once, in
// `checkBareDigits`, before any masking or tokenizing — not per-token here
// — because the same characters could otherwise hide inside a fence marker
// or an anchor tag too, not just a following-word check. Written as escape
// sequences, deliberately, never as literal characters in this source file
// — an actual zero-width character sitting in this regex literal would be
// exactly as invisible and unauditable here as the bypass it exists to
// close. U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+2060 word joiner, U+FEFF
// BOM/zero-width-no-break-space.
export const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g

// A short list of named HTML entities a PR body could plausibly carry
// (GitHub renders raw HTML in markdown) that would otherwise wrap a
// disqualifying word invisibly to every quote/bracket strip below (round 4
// finding 4: `&quot;tests&quot;`, `&lt;tests&gt;`). Decoded the same place
// zero-width characters are stripped — once, on the whole body — not
// reimplemented as a per-token special case.
const HTML_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&'
}
export function decodeNamedEntities(body: string): string {
  return body.replace(/&(?:quot|apos|lt|gt|amp);/g, (m) => HTML_ENTITIES[m] ?? m)
}

// Unicode punctuation BY CATEGORY, not an enumerated character list (round
// 4's own positive finding: this is what round 3's \d → \p{Nd} fix did
// right, and what round 4 asked stripOuterPunct to do too — guillemets,
// fullwidth parens, CJK corner brackets all strip the same way ASCII ones
// do now). `\p{Ps}`/`\p{Pi}` (open brackets, initial quotes) lead;
// `\p{Pe}`/`\p{Pf}`/`\p{Po}` (close brackets, final quotes, other
// punctuation — periods, commas, straight quotes, `*`) trail. `#`/`§` are
// deliberately EXCLUDED from the leading class even though they are
// `\p{Po}` too — `ISSUE_REF`/`SECTION_SYMBOL` need them left on `core`, so
// leading strip stays a narrower category set than trailing. Backtick is a
// Symbol (`\p{Sk}`), not Punctuation, and is listed explicitly on both
// sides for the same reason it always was.
function stripOuterPunct(token: string): string {
  return token
    .replace(/^[\p{Ps}\p{Pi}`*]+/u, '')
    .replace(/[\p{Pe}\p{Pf}\p{Po}`*]+$/u, '')
    .replace(/['’]s$/iu, '')
    .replace(/[\p{Pe}\p{Pf}\p{Po}`*]+$/u, '')
}

/** Articles/prepositions that don't themselves carry the claim — skipped, not counted, when looking for the noun after them ("step 200 of the tests failed"; round 2 security review finding). */
const FUNCTION_WORD = /^(of|the|a|an|in|on|at|to|for|with|by)$/i

/**
 * Builds the word sequence handed to the grammar check: `followingWords`,
 * stopping at the first real clause boundary instead of trusting a fixed
 * word count to land inside the same clause as the digit. Two boundary
 * shapes, both found live against the real corpus while validating this
 * design (a `(a glob technically alive...)` aside must never read as
 * describing the number before it; `exit 128). The trap...` must not let
 * the NEXT sentence's subject read as describing the number in THIS one):
 *   - A parenthetical/bracketed span is skipped whole, not just its
 *     opening token — depth-tracked, so nesting doesn't close early.
 *   - A token that is pure punctuation/symbol (nothing alphanumeric at
 *     all), or that ends in sentence-terminal `.`/`!`/`?`, ends collection
 *     at that token. This is what stops the vocabulary scan below from
 *     reaching into a real, unrelated later mention of a `COUNT_NOUN` word
 *     several clauses down a long sentence — a real false positive found
 *     against #136's own body while widening the lookahead for round 4
 *     finding 5: a standalone em dash (`… step 4):** reproduced live
 *     before writing any test — a plain \`mktemp -d\` …`) is this repo's
 *     own house style for a clause break, and wasn't being recognized as
 *     one at all (only bracket-adjacent closing punctuation was).
 */
const PURE_PUNCTUATION = /^[\p{P}\p{S}]+$/u

function clauseBoundedFollowing(followingWords: string[]): string[] {
  const out: string[] = []
  let depth = 0
  for (const raw of followingWords) {
    const opens = (raw.match(/[([]/g) ?? []).length
    const closes = (raw.match(/[)\]]/g) ?? []).length
    if (depth > 0) {
      depth = Math.max(0, depth + opens - closes)
      continue
    }
    if (opens > closes) {
      depth += opens - closes
      continue
    }
    if (PURE_PUNCTUATION.test(raw)) break // standalone punctuation/symbol token — clause boundary
    out.push(raw)
    if (/[.!?]$/.test(raw.replace(/[)\]'"`*’”]+$/, ''))) break // sentence-terminal, attached to this word
  }
  return out
}

/**
 * The real grammar check (round 4; see the module doc for why this
 * replaced a vocabulary as the primary signal): does a POS tagger
 * (`compromise`) read the digit as immediately followed, within the same
 * clause, by a tagged noun? `#Value+ #Noun+` requires direct adjacency —
 * deliberately not loosened to tolerate an intervening word, because doing
 * so is what let "shape 2 (a glob technically alive...)" read as a claim
 * about "2" in testing (an adjective/determiner-tolerant pattern matches
 * straight into a parenthetical aside). The cost of that strictness is a
 * compound noun whose head sits one modifier away ("200 support tickets")
 * — `COUNT_NOUN` and this being a union, not a replacement, is what
 * covers that gap without loosening the adjacency requirement that keeps
 * the parenthetical-aside case safe.
 *
 * `COUNT_NOUN`'s own lookahead is bounded to four CONTENT words within the
 * clause (function words skipped free, same as before) — deliberately NOT
 * unbounded to the whole clause. That was tried (round 4 finding 5's own
 * fix, briefly): the clause boundary alone is not a tight enough box for
 * `COUNT_NOUN` specifically, because this repo's own prose runs long
 * between hard punctuation — re-verifying against the real corpus after
 * unbounding found `COUNT_NOUN` reaching six words out into #136's own
 * body ("step 4):** reproduced live before writing any test —") and
 * flagging a real, required-clean label as a claim. A four-word budget
 * remains beatable by a long enough filler chain (finding 5's own "of the
 * grand total final number of tests" needs five) — accepted here as a
 * narrower, honestly-documented residual: closing it fully would require
 * either full sentence semantics (out of reach for a word-distance
 * heuristic by construction) or risks the exact #136 regression just
 * found. The grammar check below is NOT similarly bounded, and does not
 * need to be — `#Value+ #Noun+`'s direct-adjacency requirement means a
 * word six clauses away can never match it regardless of clause length.
 */
function hasDisqualifyingClaim(digitToken: string, followingWords: string[]): boolean {
  const clause = clauseBoundedFollowing(followingWords)
  if (clause.length === 0) return false

  let checked = 0
  for (const raw of clause) {
    const core = stripOuterPunct(raw)
    if (FUNCTION_WORD.test(core)) continue
    if (checked >= 4) break
    checked++
    if (COUNT_NOUN.test(core)) return true
  }

  // A self-contained bracketed token ("(pass)", both the open and close on
  // the SAME token) is a parenthetical aside just as much as a bracket
  // spanning several tokens is — `clauseBoundedFollowing`'s depth tracking
  // only excludes the multi-token span shape. Left in, "exit 0 (pass)"
  // read as `#Value+ #Noun+` matching straight across the parenthesis
  // (compromise tags "pass" a noun) and flagged three real, required-clean
  // `**exit 0** (pass)` list items in #126 as claims. Grammar adjacency
  // must never cross a parenthetical, self-contained or not, so these are
  // dropped before the chunk is built — never fed to `nlp()` at all.
  const grammarWords = clause.filter((w) => {
    const opens = (w.match(/[([]/g) ?? []).length
    const closes = (w.match(/[)\]]/g) ?? []).length
    return !(opens >= 1 && closes >= 1)
  })
  if (grammarWords.length === 0) return false
  // `ordinalWord` is deliberately NOT in this chunk, and the match is
  // anchored with `^` — both closing a false positive found live against
  // #136's own body: "exit 128). The trap applies exactly as §2
  // describes." is one clause (no sentence break before "§2"), and an
  // UNANCHORED `#Value+ #Noun+` search matches "§2 describes." — a wholly
  // different number later in the same clause, misread as evidence about
  // digit 128 purely because it also satisfies the pattern *somewhere* in
  // the chunk. Anchoring to the start, with the digit as the chunk's own
  // first word, makes the match mean "immediately after THIS digit," not
  // "found this shape anywhere downstream." `ordinalWord` was never load
  // bearing for the match itself (verified empirically) and only got in
  // the anchor's way (`^#Value+` cannot match after a leading `step`/
  // `round` token, which compromise tags as a Verb here, not part of the
  // Value run).
  const doc = nlp([digitToken, ...grammarWords].join(' '))
  return doc.match('^#Value+ #Noun+').found
}

/**
 * Classifies one digit-bearing token found outside every masked region.
 * `precedingWord` is the previous whitespace-separated token on the same
 * (original) line, or `null` at line start. `followingWords` are the
 * whitespace-separated tokens after this one (the caller passes a handful
 * — `hasDisqualifyingClaim` skips function words and clause boundaries
 * within that budget rather than spending it on them) — both used only by
 * the ordinal-word rule below.
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
  // The disqualifying-claim lookahead matters just as much, and
  // independently: a preceding label word is necessary but not sufficient
  // (security review, this task — see `hasDisqualifyingClaim`'s doc for
  // the empirical proof). "step 200 tests" has the identical
  // preceding-word shape as "exit 0 on success"; only checking what
  // follows the number tells them apart.
  if (
    precedingWord &&
    !precedingWord.endsWith(',') &&
    ORDINAL_WORD.test(stripOuterPunct(precedingWord)) &&
    ORDINAL_VALUE.test(core) &&
    !hasDisqualifyingClaim(rawToken, followingWords)
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
 *
 * Normalizes FIRST, before any masking or tokenizing — `ZERO_WIDTH`
 * stripping and named-HTML-entity decoding both need to happen once, on
 * the raw body, not per-token: a zero-width character could hide inside a
 * fence marker or an anchor tag just as easily as inside a following-word
 * check (round 4 security review, finding 2 — the most severe of that
 * round, closing a bypass class rather than one instance of it).
 */
export function checkBareDigits(rawBody: string): BareDigitScanResult {
  const body = decodeNamedEntities(rawBody.replace(ZERO_WIDTH, ''))
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
      // 12 raw tokens, not 2 — `hasDisqualifyingClaim` skips function
      // words and stops at clause boundaries within that budget rather
      // than spending it on them, so it needs room past them in the raw
      // slice.
      const followingWords = after.length > 0 ? after.split(/\s+/).slice(0, 12) : []
      if (isExemptToken(rawToken, precedingWord, followingWords)) continue
      violations.push({ line: i + 1, text: origLine.trim() })
    }
  }

  return { violations }
}
