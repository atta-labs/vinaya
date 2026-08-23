/**
 * Pure scan logic for the `body-bare-digits` check (fix/body-bare-digits).
 * No `fs`, no `git`/`gh` — the caller supplies the PR body text; every fact
 * this needs comes from that one string, so this is unit-testable with plain
 * string fixtures alone. `check-body-bare-digits.ts` is the thin wiring that
 * reads `PR_BODY` and calls this.
 *
 * The rule, collapsed to one sentence (Principal redesign, after round 6
 * confirmed the original per-shape exemption list would never converge): **a
 * digit is exempt iff it sits inside an inline code span, a fenced/indented
 * code block, or an `AEG:*` anchored region. Nowhere else.**
 *
 * What this replaced: five security review rounds plus three proactive
 * self-audit fixes each found a new way a digit could escape a growing list
 * of named identifier shapes — Issue/PR ref, ISO date, dotted version,
 * section symbol, an ordinal-word + closed-vocabulary count-noun pair, a
 * letter-led alphanumeric id, an inline `(N)` enumeration marker, a file-path
 * segment, a URL. Each fix closed exactly the reported case; the underlying
 * problem was never any one shape's regex, it was that "enumerate every
 * shape a digit can innocently take" is an open-ended, unbounded problem by
 * construction — a POS tagger (`compromise`, round 4's own fix) made the
 * open-vocabulary half more general but did not change that shape, and round
 * 6 (plus this task's own second self-audit) kept finding the next
 * uncovered one (hyphenated-word laundering, a mid-sentence token merely
 * shaped like a list marker, a URL check that only tested for a substring).
 * A closed identifier-shape list can always be beaten by a shape not yet on
 * the list; "is this digit inside a block a human explicitly fenced off,"
 * with no shape enumeration at all, cannot.
 *
 * **The real-world cost, stated plainly, not hidden in a corpus number:**
 * this makes every digit-bearing identifier a PR body wants to cite —
 * `#123`, `2026-08-18`, `0.12.0`, `packages/aeg-forge-state/src/strip-code.ts`,
 * `§9` — require backtick-wrapping to pass, where the old exemption list let
 * them stand bare. That is not a defect in this rewrite; it is what "one
 * rule, no enumerable shape space" necessarily means. Real corpus bodies
 * written before this rule existed (`#126`/`#129`/`#130`/`#132`/`#136`) were
 * not written with it in mind and are re-verified against it honestly in
 * this PR's Test Plan, not silently patched to pass.
 *
 * Masking pipeline, in the order each layer depends on the one before it —
 * unchanged from before this redesign, because none of it is a per-token
 * identifier-*shape* classifier; each layer masks a whole, independently
 * authorized STRUCTURAL region (a code span, a collapsed reference block, an
 * anchored field, the mandatory Token report table, an anchor-optional
 * header line), never a guess about what a bare digit's shape might mean:
 *   1. `maskCode` — blind fenced/indented code and inline spans (including
 *      single-backtick spans — this already existed before this redesign;
 *      no new masking primitive was needed). Must run before
 *      `maskDetailsBlocks`: a `<details>` tag quoted in a code span must
 *      already be inert filler before the details-scanner sees it, or a
 *      decoy tag could open/close a fake region (`anchoredRegionBounds`'s
 *      PR #126 fix closed the identical decoy class for the `AEG:*`
 *      anchors).
 *   2. `maskDetailsBlocks` — blind the collapsed `<details>` block that
 *      carries the frozen, verbatim reference-brief copy
 *      (`aeg-root/templates/pr-report-template.md`: "the gates read the
 *      anchored fields above, never this block").
 *   3. Blank each present `AEG:*` anchor region (`anchoredRegionBounds`) —
 *      the one region kind this task's own rule names explicitly.
 *   4. Blank the `## Token report` section (heading to next heading or
 *      end-of-body) — a mandatory, un-anchored table on every PR
 *      (`aeg-root/roles/developer.md` §"Reporting exact tokens") whose
 *      cells are self-reported turn metadata, not a claim about the code
 *      under review; exempting it by heading was its own separate,
 *      Principal-approved decision, not a digit-shape classifier.
 *   5. Blank `**For:**` / `**Tier:**` / `**Project:**` header lines when not
 *      already inside their `AEG:*` anchor — the anchor-optional fallback
 *      for a body's own mandatory metadata fields, same reasoning as layer
 *      4.
 *
 * What survives that pipeline is scanned for digit-bearing tokens; every
 * surviving one is a violation, full stop — no shape it could take makes it
 * exempt. The one narrow, deliberate carve-out kept from the old design: a
 * markdown ordered-list marker's own digit (`1.`/`2)`), but ONLY when it
 * actually sits at the very start of its line (`isLineLeadingListMarker`).
 * This is not an identifier-shape exemption in the sense every round
 * attacked — it has zero laundering surface (a claim cannot be smuggled by
 * writing it at column zero followed by `.`/`)`, since that is real GFM list
 * syntax GitHub itself renders as a list, not prose), and without it this
 * check would fail its own numbered sections and every ordinary PR body's
 * ordered lists. Kept narrow on purpose: `isExemptToken`'s OWN prior copy of
 * this same regex, checked without the position requirement, was one of
 * this task's own proactive-audit findings (a mid-sentence "N."/"N)" token
 * escaping unconditionally) — the position check is what keeps this
 * carve-out from reopening that exact class.
 */

import { anchoredRegionBounds, TIER_FIELD } from '@attalabs/aeg-core'
import { EVIDENCE_SUMMARY_PREFIX } from '../lib/numstat'
import { PROJECT_SLUG, unwrapValue } from '@attalabs/aeg-forge-state'
import { maskCode, maskDetailsBlocks } from '@attalabs/aeg-forge-state/strip-code'

export type BareDigitViolation = { line: number; text: string }
export type BareDigitScanResult = { violations: BareDigitViolation[] }

/** Blanks `[start, end)` of `text`, preserving every `\n` so line numbers downstream stay correct. */
function blankRange(text: string, start: number, end: number): string {
  const region = text.slice(start, end)
  return text.slice(0, start) + region.replace(/[^\n]/g, ' ') + text.slice(end)
}

/**
 * The six `AEG:*` fields, split into two groups by Principal direction
 * (this task's final round): `EXEMPT_ANCHOR_FIELDS` get a real, bounded,
 * mechanical exemption reusing each field's own already-hardened grammar —
 * `PREMISE`/`TEST-PLAN` get NONE at all, the identical treatment `For:`
 * already had (see `blankUnanchoredStructuralFields`'s doc): no anchor
 * exemption, no section check, no signature check — a digit anywhere in
 * their content, evidence included (fixture output, byte counts, exit
 * codes), now needs its own backticks like everywhere else in the body.
 *
 * Why: `PREMISE`/`TEST-PLAN` were tried with the same bounded-per-line
 * approach `CLOSES`/`TIER`/`PROJECT`/`EVIDENCE` use below, and reverted —
 * real corpus verification found their real content isn't just a single
 * header/bullet/checklist line, it's genuinely multi-line free text
 * (indented continuation prose under a Test Plan item; an arbitrary
 * `contains`/`absent` assertion value). Every bound tried either broke
 * real usage or left a residual — a judgment call for a reviewer either
 * way. Per the Principal's final direction: no carve-outs, no residual
 * left for a reviewer's judgment — the same mechanical rule `For:` already
 * enforces, applied here too. The real-world cost is identical in kind to
 * `For:`'s own: existing PR bodies with a bare digit in Premise/Test-Plan
 * content need backtick-wrapping to keep passing, migrated the same way
 * `#129`'s `For:` line was for this task's own dogfooding.
 */
const EXEMPT_ANCHOR_FIELDS = ['CLOSES', 'TIER', 'PROJECT', 'EVIDENCE'] as const
type ExemptAnchorField = (typeof EXEMPT_ANCHOR_FIELDS)[number]

/**
 * The canonical section each exempt field is documented to live in
 * (`aeg-root/templates/pr-report-template.md`): `CLOSES`/`PROJECT` sit in
 * the header block, before the first `##` heading; `TIER`/`EVIDENCE` sit
 * under their own named heading.
 *
 * Round 6 security review, HIGH: `anchoredRegionBounds` trusts ANY
 * well-formed `<!-- AEG:<FIELD>:START -->…<!-- AEG:<FIELD>:END -->` pair
 * anywhere in the body — correct and safe for its own designed purpose
 * (`packages/aeg-core/src/anchored-region.ts`'s own doc: value resolution,
 * "when a pair is present, it is authoritative"), because every other
 * consumer (`pr-tier.ts`, `test-plan-section.ts`, `premise-check.ts`,
 * `brief-validation.ts`, `coherence-checks.ts`) only ever reads a value
 * FROM inside a trusted pair — it never had to ask "trusted by whom, to
 * exempt WHAT." This check repurposes that same presence-as-trust for a
 * different, security-relevant purpose (exempting content from a
 * false-claim scan), a trust model `anchoredRegionBounds` was never
 * validated against. Reproduced: a decoy
 * `<!-- AEG:PROJECT:START -->\nWe actually observed 4500 regressions in
 * this pass.\n<!-- AEG:PROJECT:END -->` — for a field the body doesn't
 * otherwise anchor, placed anywhere in ordinary prose — scored zero
 * violations.
 *
 * Fixed locally, in this file, deliberately not in `anchored-region.ts`
 * itself: that module's own trust model stays correct for its actual,
 * non-adversarial consumers, all five of which this task must not regress,
 * and touching a shared primitive for one new consumer's stricter need is
 * exactly the brief's own named Stop Condition — this is that call, made
 * the narrower way. An anchor pair is trusted for EXEMPTION here only when
 * its start marker falls inside the section that field is documented to
 * live in. A decoy pair placed anywhere else — the exploit shape round 6
 * found — no longer qualifies; its content is scanned as ordinary prose
 * instead, the fail-safe direction per this task's own Constraint (flag
 * when in doubt, never swallow).
 */
const FIELD_SECTION_HEADING: Record<ExemptAnchorField, RegExp | null> = {
  CLOSES: null,
  PROJECT: null,
  TIER: /^scope$/i,
  EVIDENCE: /^evidence$/i
}

const HEADING = /^#{1,6}\s/
const HEADING_TEXT = /^#{1,6}\s+(.*?)\s*$/

/** Char offset where the body's header block ends — the first heading line, or `body.length` if none. */
function headerBlockEnd(body: string): number {
  const lines = body.split('\n')
  let offset = 0
  for (const line of lines) {
    if (HEADING.test(line)) return offset
    offset += line.length + 1
  }
  return body.length
}

/** `[start, end)` char offsets of the first section whose heading text matches `namePattern`, or `null` if no such heading exists in this body. */
function namedSectionBounds(body: string, namePattern: RegExp): { start: number; end: number } | null {
  const lines = body.split('\n')
  let offset = 0
  let start = -1
  let end = body.length
  for (const line of lines) {
    const headingText = HEADING_TEXT.exec(line)
    if (start === -1 && headingText && namePattern.test(headingText[1] as string)) {
      start = offset
    } else if (start !== -1 && HEADING.test(line)) {
      end = offset
      break
    }
    offset += line.length + 1
  }
  return start === -1 ? null : { start, end }
}

/** Does this field's anchor pair, starting at `outerStart` in `body`, sit inside the section it's documented to live in? */
function isInCanonicalSection(body: string, field: ExemptAnchorField, outerStart: number): boolean {
  const pattern = FIELD_SECTION_HEADING[field]
  if (pattern === null) return outerStart < headerBlockEnd(body)
  const bounds = namedSectionBounds(body, pattern)
  return bounds !== null && outerStart >= bounds.start && outerStart < bounds.end
}

/**
 * Round 8 security review, HIGH (round 6/7's own recommendation, finally
 * acted on — not a new finding, a real oversight last round: round 7's
 * push fixed the unrelated structural-field BLOCKER and never came back to
 * this one, even though it was reported live at that same head). Location
 * alone — `isInCanonicalSection` — never closed the decoy-anchor gap, only
 * narrowed the precondition: an attacker only has to make their decoy the
 * FIRST anchor pair for that field INSIDE its own legitimate section, since
 * every one of these sections is itself a legitimate free-text zone.
 * Reproduced fresh: a decoy `AEG:PROJECT`/`AEG:CLOSES` pair in the header
 * block, a decoy `AEG:TIER` pair under `## Scope`, a decoy `AEG:EVIDENCE`
 * pair under `## Evidence`, each wrapping a fabricated quantitative claim
 * with no trace of the field's own real declaration inside it — all scored
 * zero violations.
 *
 * Closed the way round 7 closed the Tier/Project structural-field gap:
 * reuse, don't invent a new classifier. Every real anchored body already
 * repeats that field's own declaration INSIDE the pair, per the canonical
 * template (`aeg-root/templates/pr-report-template.md`) itself — a decoy
 * that skips reproducing it is the actual, reliable tell. `TIER`/`PROJECT`
 * reuse the exact grammars `blankTierField`/`blankProjectField` already
 * import for the unanchored fallback (`TIER_FIELD`, `PROJECT_LABEL`); the
 * other two check for the literal required text the template mandates as
 * that field's own first content: `Closes #N` (`CLOSES`), `Head: <sha>`
 * (`EVIDENCE`, `vinaya pr report --write`'s own emitted, never-hand-typed
 * first line). Content failing its field's own signature is scanned as
 * ordinary prose instead — a decoy carrying no trace of the real field it
 * impersonates no longer borrows its trust.
 */
/** The `Project:`/`**Project:**` label prefix — shared by `blankProjectField` (the unanchored fallback) and `FIELD_CONTENT_SIGNATURE.PROJECT` (below). */
const PROJECT_LABEL = /^\s*(?:\*\*)?Project(?:\(s\))?(?:\*\*)?\s*:\s*(?:\*\*)?/i

const FIELD_CONTENT_SIGNATURE: Record<ExemptAnchorField, RegExp> = {
  CLOSES: /Closes\s*#\d+/i,
  PROJECT: PROJECT_LABEL,
  TIER: TIER_FIELD,
  EVIDENCE: /^Head:\s*\S/m
}

/**
 * Blanks each `EXEMPT_ANCHOR_FIELDS` anchor's outer region — see module
 * doc above for why only these four, and the `BOUNDED_ANCHOR_BLANK` doc
 * below for why every one of them blanks only its own bounded value
 * inside the pair, never the whole span. `PREMISE`/`TEST-PLAN` are not in
 * `EXEMPT_ANCHOR_FIELDS` at all — no exemption of any kind, mechanical and
 * final, per the module doc above.
 */
function blankAnchoredRegions(body: string): string {
  let masked = body
  for (const field of EXEMPT_ANCHOR_FIELDS) {
    // Bounds are computed against `body` each time (never against a
    // shrinking/growing `masked`) because every blank here is same-length —
    // positions never drift, so re-deriving against the immutable original
    // is simpler than threading offset corrections, and can never
    // mis-locate a later anchor because an earlier blank moved something.
    const bounds = anchoredRegionBounds(body, field)
    if (!bounds || !isInCanonicalSection(body, field, bounds.outerStart)) continue
    const content = body.slice(bounds.innerStart, bounds.innerEnd)
    if (!FIELD_CONTENT_SIGNATURE[field].test(content)) continue
    masked = blankRange(masked, bounds.outerStart, bounds.innerStart)
    masked = blankRange(masked, bounds.innerEnd, bounds.outerEnd)
    const blankLine = BOUNDED_ANCHOR_BLANK[field]()
    const blankedContent = content
      .split('\n')
      .map((l) => blankLine(l))
      .join('\n')
    masked = masked.slice(0, bounds.innerStart) + blankedContent + masked.slice(bounds.innerEnd)
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
 * Blanks the unanchored `Tier:`/`Project:` fallback forms — the
 * anchor-optional convention layer 3 doesn't reach (an older, pre-anchor
 * body like `#126` writes them bare, and `vinaya demo`'s own fixture PR
 * body writes a plain, unbolded `Tier: 1`).
 *
 * Round 6 security review, HIGH: this used to blank the WHOLE line once the
 * label matched. Round 7 found the round-6 fix (blank up to the first
 * clause-boundary punctuation) was still a guessable shape, not a closed
 * one — `Tier: 1 500 known regressions untriaged` (no punctuation between
 * the real value and the claim) scored zero violations, same bug, narrower
 * trigger. The actual fix, per this round: don't guess the value's
 * boundary at all — REUSE the exact grammar the field's own real reader
 * already validates against, the same "reuse a hardened primitive, don't
 * hand-roll a shape detector" discipline this whole task started from
 * (`stripCode`/`maskCode`, `anchoredRegionBounds`).
 *
 * `Tier:` — `TIER_FIELD` (`@attalabs/aeg-core`, `pr-tier.ts`) is the exact
 * regex `readTierFromPrBody` already uses to parse the field CI enforces;
 * exported (additive, behavior-unchanged for that module) so this check
 * can blank precisely what that regex matches, nothing appended after it.
 *
 * `Project:` — `PROJECT_SLUG`/`unwrapValue` (`@attalabs/aeg-forge-state`,
 * `list-tasks.ts`) are the exact validation `projectFieldFromBody` already
 * applies per comma-separated segment to tell a real project name apart
 * from smuggled prose (`parseFieldValue`'s own `unparsed` bucket is
 * precisely "failed this same check"). Reused the same way: each
 * comma-separated segment after the label is blanked only if it validates
 * as a real name; a segment that doesn't (a claim disguised as an extra
 * "name") stays unmasked and gets scanned like anything else.
 *
 * `For:` used to get the same whole-line treatment `Tier:`/`Project:` had
 * before round 6. It has no `AEG:*` anchor to fall back to at all
 * (`ANCHOR_FIELDS` has no `FOR` entry) and no existing hardened grammar to
 * reuse the way `Tier:`/`Project:` now do (no gate reads or validates it),
 * so a bounded-value fix isn't available for it the way it was for the
 * other two. Round 7 correctly reproduced the whole-line exemption as
 * still live (`**For:** Sonnet 5 (…) — we actually fixed 4500 bugs` scored
 * zero) and correctly called the prior doc comment's "not a reopened gap"
 * claim inaccurate. Per the Principal's direct call: `For:` no longer gets
 * ANY special-cased digit tolerance — the label line still parses (nothing
 * about it needs blanking; it never itself carries a digit), but any digit
 * in its value now needs its own backticks, same as everywhere else in the
 * body. The real cost, same as every other identifier this redesign
 * stopped exempting: a `For:` line naming a model version bare (`Sonnet
 * 5`) now needs `Sonnet \`5\``, going forward — disclosed, not silent.
 */

/**
 * No line-start pre-filter before `TIER_FIELD.exec` — deliberately, because
 * `TIER_FIELD` isn't line-anchored either. `pr-tier.ts`'s own doc says why:
 * the field may sit mid-line in metadata (`Tranche: x · Task: 1 · **Tier:**
 * 3 · Project: y`). Gating this on a line-start match first (tried,
 * reverted) silently broke exactly that real, documented shape — the
 * legitimate `3` went unmasked and got flagged, a regression caught
 * empirically before this ever left the local scratch script.
 */
function blankTierField(line: string): string {
  const m = TIER_FIELD.exec(line)
  if (!m) return line
  return line.slice(0, m.index) + ' '.repeat(m[0].length) + line.slice(m.index + m[0].length)
}

// Round 9 code review, BLOCKER: `PROJECT_SLUG` (`/^[a-z0-9][a-z0-9-]*$/i`)
// is the real, shared shape every genuine project name in this repo's own
// registry satisfies — but it's also the shape ANY hyphenated claim
// satisfies, with no comma or space needed to trip it: `we-fixed-4500-bugs`
// passes `PROJECT_SLUG` exactly as `aeg-core`/`cli`/`vinaya-sources` do,
// laundering a claim past a genuinely-signed anchor, no decoy required.
// `PROJECT_SLUG` is the real shared grammar (`@attalabs/aeg-forge-state`)
// and stays reused as-is, not re-narrowed here — a repo elsewhere in this
// ecosystem could legitimately register a digit-bearing project name, and
// this file is not the place to change what counts as a valid slug
// project-wide. What changes locally: a segment is trusted as a real name
// ONLY if it also carries no digit at all — every real name in this
// repo's own corpus (`aeg-core`, `cli`, `vinaya`, `vinaya-sources`,
// `aeg-forge-state`, `aeg-types`) already satisfies that, so nothing real
// is lost; a fake name built specifically to smuggle a digit through the
// shape check no longer can, the same "don't trust shape alone when shape
// can hide a real claim" principle this file already applies everywhere
// else (round 5's file-path fix, `TIER_FIELD`'s closed `[013]` enum).
const SEGMENT_HAS_DIGIT = /\p{Nd}/u

function blankProjectField(line: string): string {
  const label = PROJECT_LABEL.exec(line)
  if (!label) return line
  const valueStart = label.index + label[0].length
  const segments = line.slice(valueStart).split(',')
  const blanked = segments.map((seg) => {
    const name = unwrapValue(seg)
    const isRealName = PROJECT_SLUG.test(name) && !SEGMENT_HAS_DIGIT.test(name)
    return isRealName ? ' '.repeat(seg.length) : seg
  })
  return line.slice(0, valueStart) + blanked.join(',')
}

function blankUnanchoredStructuralFields(body: string): string {
  return body
    .split('\n')
    .map((l) => blankProjectField(blankTierField(l)))
    .join('\n')
}

/**
 * Self-discovered proactive audit (not yet reported by any review round):
 * checking a signature is merely PRESENT inside an anchor's content is not
 * the same as the content BEING just that value — a "trojan" anchor can
 * carry a real, valid signature alongside a smuggled claim in the same
 * pair (`<!-- AEG:TIER:START -->\n**Tier:** 1 and also 500 known
 * regressions remain untriaged\n<!-- AEG:TIER:END -->`), and blanking the
 * WHOLE span once the signature is found would hide the smuggled digit
 * too — the identical class of gap `FIELD_CONTENT_SIGNATURE` closed for a
 * bare decoy, reopened one level in.
 *
 * `CLOSES`/`TIER`/`PROJECT`/`EVIDENCE` — the four fields in
 * `EXEMPT_ANCHOR_FIELDS` — are bounded per line inside their anchor,
 * reusing the same short, already-hardened grammars reused above for the
 * unanchored fallback (`TIER_FIELD`, `PROJECT_LABEL`/`PROJECT_SLUG`) or a
 * literal required signature (`Closes #N`; `EVIDENCE`'s content is
 * machine-emitted only — `vinaya pr report --write`, never hand-typed —
 * and past `maskCode`'s own masking of its inline-code/fenced-diff-stat
 * spans, layer 1, the only lines that ever remain are the `Head: <sha>`
 * line and `### Group A/B — …` headings, confirmed against every real
 * corpus body this task has verified against). `PREMISE`/`TEST-PLAN` are
 * NOT in `EXEMPT_ANCHOR_FIELDS` at all any more — a bounded per-line
 * approach was tried for them too (`isPremiseHeader`/`PREMISE_LINE` and a
 * Test Plan checklist-item regex, both from `@attalabs/aeg-core`) and
 * reverted after re-verifying against the real corpus surfaced a real
 * regression: real Test Plan items in `#130`/`#136` carry indented,
 * multi-paragraph continuation prose UNDER the checklist line (fixture
 * output, byte counts, exit codes) that a first-line-only bound wrongly
 * flagged. Per the Principal's final direction for this task, PREMISE/
 * TEST-PLAN get the same treatment as `For:` instead — zero exemption of
 * any kind, mechanical, not another bounding attempt — see the module doc
 * at the top of this file and `blankUnanchoredStructuralFields`'s own doc.
 */
const CLOSES_REF = /Closes\s*#\d+/i
const EVIDENCE_HEADING = /^#{1,6}\s/
const EVIDENCE_HEAD_LINE = /^Head:\s*\S+$/i

function blankClosesField(line: string): string {
  const m = CLOSES_REF.exec(line)
  if (!m) return line
  return line.slice(0, m.index) + ' '.repeat(m[0].length) + line.slice(m.index + m[0].length)
}

/**
 * A fresh blanker per region, because the `Summary:` exemption is
 * first-occurrence-only.
 *
 * `evidence-fresh` verifies the FIRST emitted `Summary:` line and no other
 * (`region.match` on a non-global regex). Exempting every occurrence would
 * leave a second, unverified `Summary:` line free to carry any figure at all —
 * exempt because a different line was checked. So the second one is scanned as
 * ordinary prose, which is what it is. The prefix test is `startsWith` on the
 * RAW line against the shared `EVIDENCE_SUMMARY_PREFIX`: column 0,
 * case-sensitive, exactly the shape the emitter writes and the verifier reads.
 */
function makeBlankEvidenceField(): (line: string) => string {
  let summarySeen = false
  return (line: string): string => {
    const trimmed = line.trim()
    if (line.startsWith(EVIDENCE_SUMMARY_PREFIX) && !summarySeen) {
      summarySeen = true
      return ' '.repeat(line.length)
    }
    if (trimmed === '' || EVIDENCE_HEAD_LINE.test(trimmed) || EVIDENCE_HEADING.test(trimmed))
      return ' '.repeat(line.length)
    return line
  }
}

/** Factories, not functions: `EVIDENCE` needs per-region state (see `makeBlankEvidenceField`). */
const BOUNDED_ANCHOR_BLANK: Record<ExemptAnchorField, () => (line: string) => string> = {
  CLOSES: () => blankClosesField,
  TIER: () => blankTierField,
  PROJECT: () => blankProjectField,
  EVIDENCE: makeBlankEvidenceField
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
// exemption gap, a detection gap. This is the base candidate-detection
// regex; every token it matches that survives `buildScanMask` is a
// violation, no further shape classification applied.
const TOKEN_WITH_DIGIT = /\S*\p{Nd}\S*/gu

/** A markdown ordered-list marker's own digits: `1.` / `2)` etc. */
const LIST_MARKER_TOKEN = /^\p{Nd}{1,9}[.)]$/u

// Zero-width and other Unicode default-ignorable characters — security
// review round 4 found one embedded inside an otherwise-recognized token
// ("te" + U+200B + "sts") defeats regex matching regardless of what the
// regex is looking for — the same risk applies to the masking boundaries
// themselves (a fence marker, an `AEG:*` tag) under this redesign, not just
// a vocabulary word under the old one. Stripped from the WHOLE body once, in
// `checkBareDigits`, before any masking or tokenizing — not per-token here —
// because the same characters could otherwise hide inside a fence marker or
// an anchor tag too. Written as escape sequences, deliberately, never as
// literal characters in this source file — an actual zero-width character
// sitting in this regex literal would be exactly as invisible and
// unauditable here as the bypass it exists to close. U+200B ZWSP, U+200C
// ZWNJ, U+200D ZWJ, U+2060 word joiner, U+FEFF BOM/zero-width-no-break-space.
export const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g

// A short list of named HTML entities a PR body could plausibly carry
// (GitHub renders raw HTML in markdown) that would otherwise wrap masking
// boundary characters (a fence backtick, an anchor's `<`/`>`) invisibly to
// every mask below (round 4 finding 4). Decoded the same place zero-width
// characters are stripped — once, on the whole body — not reimplemented as
// a per-token special case.
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

/**
 * A markdown ordered-list marker (`1.`/`2)`) must sit at the very start of
 * its line (≤3 leading spaces, nothing else before it) to count as a list
 * marker rather than a coincidentally dot/paren-suffixed number appearing
 * mid-sentence. See module doc for why this is the one exemption kept from
 * the old per-shape design, and why it carries no laundering risk.
 */
function isLineLeadingListMarker(line: string, matchStart: number, rawToken: string): boolean {
  if (!LIST_MARKER_TOKEN.test(rawToken)) return false
  const before = line.slice(0, matchStart)
  return /^ {0,3}$/.test(before)
}

/**
 * Scans `body` for bare digits outside every masked region. Returns one
 * violation per surviving digit-bearing token, in document order. No
 * per-token shape classification beyond the line-leading list-marker check
 * — see module doc for the collapsed rule this replaced.
 *
 * Normalizes FIRST, before any masking or tokenizing — `ZERO_WIDTH`
 * stripping and named-HTML-entity decoding both need to happen once, on
 * the raw body, not per-token: a zero-width character could hide inside a
 * fence marker or an anchor tag just as easily as inside a token (round 4
 * security review, finding 2 — the most severe of that round, closing a
 * bypass class rather than one instance of it).
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
      violations.push({ line: i + 1, text: origLine.trim() })
    }
  }

  return { violations }
}

/**
 * Why the anchored region containing this line did not earn its exemption.
 *
 * The check's generic remediation — fence it, or restate it as a symbol — is
 * correct for narrative prose and actively wrong for a machine-generated
 * region. `vinaya pr report --write` emits `Head: <sha>` as the first line of
 * the `AEG:EVIDENCE` block; fencing or rewriting that line corrupts the block
 * the `evidence-fresh` gate byte-compares, so an author following the generic
 * advice trades one red check for another. The real cause is one of the two
 * preconditions `blankAnchoredRegions` applies beyond the anchor pair itself:
 * the region must sit in its documented section, and its content must carry
 * that field's own signature.
 *
 * Returns `null` when the line is not inside one of the `EXEMPT_ANCHOR_FIELDS`
 * regions — which includes `AEG:PREMISE` and `AEG:TEST-PLAN`, `AEG:*` regions
 * that are hand-typed and carry no exemption, so the generic advice is the
 * right advice there. A line inside a region that DID earn its exemption still
 * gets a hint, because "fence it" is wrong there too.
 */
export type AnchorExemptionDiagnosis = {
  field: ExemptAnchorField
  reason: 'outside-canonical-section' | 'content-signature' | 'exempt-region'
  hint: string
}

/** Where each field's region must live, in the words an author would use. */
const FIELD_SECTION_LABEL: Record<ExemptAnchorField, string> = {
  CLOSES: 'the header block, above the first `##` heading',
  PROJECT: 'the header block, above the first `##` heading',
  TIER: 'the `## Scope` section',
  EVIDENCE: 'the `## Evidence` section'
}

/** Char offset of the first character of 1-indexed `line`, or `null` if the body has no such line. */
function lineStartOffset(body: string, line: number): number | null {
  if (line < 1) return null
  const lines = body.split('\n')
  if (line > lines.length) return null
  let offset = 0
  for (let i = 0; i < line - 1; i++) offset += (lines[i] as string).length + 1
  return offset
}

export function diagnoseAnchorExemption(body: string, line: number): AnchorExemptionDiagnosis | null {
  const offset = lineStartOffset(body, line)
  if (offset === null) return null
  for (const field of EXEMPT_ANCHOR_FIELDS) {
    const bounds = anchoredRegionBounds(body, field)
    if (!bounds || offset < bounds.outerStart || offset >= bounds.outerEnd) continue
    if (!isInCanonicalSection(body, field, bounds.outerStart)) {
      return {
        field,
        reason: 'outside-canonical-section',
        hint: `This line is inside the \`AEG:${field}\` region, but that region is not in ${FIELD_SECTION_LABEL[field]}, so it is scanned as ordinary prose. Move the region there — do not fence or reword its contents, which \`vinaya pr report --write\` regenerates and other gates byte-compare.`
      }
    }
    if (!FIELD_CONTENT_SIGNATURE[field].test(body.slice(bounds.innerStart, bounds.innerEnd))) {
      return {
        field,
        reason: 'content-signature',
        hint: `This line is inside the \`AEG:${field}\` region, but that region does not carry the field's own declaration, so it is scanned as ordinary prose rather than trusted. Restore the declaration the template requires for \`AEG:${field}\`.`
      }
    }
    // The region DID earn its exemption, so this line is unexempted content
    // inside a machine-emitted block — narrative prose someone added to it.
    // The generic advice would say "fence it", which corrupts the block.
    return {
      field,
      reason: 'exempt-region',
      hint: `This line sits inside a valid \`AEG:${field}\` region but is not one of the lines that region exempts, so it is scanned as ordinary prose. Move the sentence out of the region — do not fence or reword the region's own contents, which \`vinaya pr report --write\` regenerates and other gates byte-compare.`
    }
  }
  return null
}
