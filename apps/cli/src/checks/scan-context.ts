/**
 * The one place a PR body is turned into the text every anchored-region
 * consumer reads (Issue #189). Pure — no `fs`, no `git`/`gh`.
 *
 * ## What this closes
 *
 * `body-bare-digits` exempts the `AEG:EVIDENCE` region's digits *because*
 * `check-evidence-fresh` verifies that region. The exemption is only sound
 * while both checks agree on **which bytes the region is**. They did not.
 *
 *   - `body-bare-digits` normalised first — zero-width strip, named-entity
 *     decode — then masked code and `<details>`, then resolved the anchor.
 *   - `check-evidence-fresh` resolved the anchor from the raw `PR_BODY`.
 *
 * One zero-width character inside `<!-- AEG:EVIDENCE:START -->` split them:
 * `body-bare-digits` stripped it, saw a real machine-emitted evidence block,
 * and exempted every digit in it; `check-evidence-fresh` saw no anchor at all,
 * took its "anchors are opt-in" bypass, and exited 0 having verified nothing.
 * Two green checks, and a fabricated headline figure between them. The
 * named-entity spelling (`&lt;!-- AEG:EVIDENCE:START --&gt;`) is the same
 * channel; so is an anchor pair reachable to one side but masked away for the
 * other.
 *
 * ## Why this shape, and not a guard
 *
 * Twelve rounds of review on `#188` each tightened an assertion over the
 * module's own source text — a pinned entry expression, a blacklist of stage
 * names, an enumerated list of consumers — and each time the divergence was
 * rewritten one stage earlier or one stage later and every assertion stayed
 * green. That is the same closed-list shape `body-bare-digits-logic.ts`'s own
 * module doc argues cannot terminate, applied one level up: a guard enumerates
 * spellings of a mistake, and there is always another spelling.
 *
 * So the composition stops being something a caller performs:
 *
 *   - `ScanContext` carries the normalised body and its anchor-lookup mask,
 *     derived together, once. It is a class with a **private member and a
 *     private constructor**, so it is nominal, not structural — an object
 *     literal shaped like it does not satisfy the type, and `new ScanContext`
 *     is a compile error outside this module. `ScanContext.from` is the only
 *     way to obtain one. (No brand pattern existed anywhere in this repo to
 *     reuse — `packages/aeg-core/src` has none — so this is the narrowest
 *     technique that needed no new dependency and no build-config change:
 *     `declaration: true` is on repo-wide, which rules out the non-exported
 *     `unique symbol` spelling.)
 *   - `resolveAnchoredRegion` is the only resolver, and it takes a
 *     `ScanContext` rather than a string — so a wrapped, re-derived, or raw
 *     body cannot reach it. `buildScanMask` (`body-bare-digits-logic.ts`)
 *     takes the context too.
 *
 * There is nothing left to enumerate: a new consumer that wants this region
 * must obtain a `ScanContext`, and the only constructor normalises. That
 * replaces the two-entry `CONSUMER_ENTRY` array and the five-name stage
 * blacklist, both of which failed **open** — a third consumer was simply
 * unlisted, and the list had to be remembered.
 *
 * ## What this does NOT close — read before trusting it
 *
 * Stated rather than papered over, because a docstring here has twice claimed
 * more than the code delivered:
 *
 *  1. **A cast.** `{} as unknown as ScanContext` defeats any nominal type in
 *     TypeScript. Nothing in the language prevents it. What changes is that
 *     the bypass has to be written as an explicit, greppable cast instead of
 *     an innocent-looking object literal.
 *  2. **A consumer that never asks for a `ScanContext`.** `anchoredRegion` /
 *     `anchoredRegionBounds` remain public exports of `@attalabs/aeg-core`,
 *     and a new check could call one directly on `PR_BODY` and diverge again.
 *     Closing that would mean the check runner handing checks a context
 *     instead of a raw `PR_BODY` string — a change to check dispatch, out of
 *     this Issue's surface. Every consumer that exists today routes through
 *     here; a future one is a review obligation, not a compile error.
 *  3. **The exemption is broader than the verification.** `body-bare-digits`
 *     blanks every heading line and every `Head:` line inside the EVIDENCE
 *     region, while `check-evidence-fresh` byte-compares only the `Head:`
 *     line, the Group A fence, and the `Summary:` line. A fabricated digit in
 *     a `### …` heading inside the block is exempt and unverified. That gap is
 *     older than this Issue and untouched by it.
 *
 *     This is also why the `Summary:` line adds no exemption of its own: its
 *     value is emitted backticked, so `maskCode` covers it. A new exemption
 *     could not have worked anyway — `body-bare-digits` runs from a
 *     `pull_request_target` checkout of the default branch, so an exemption
 *     added on a branch is not in force for the pull request that adds it.
 *  4. **Local runs verify nothing.** `check-evidence-fresh` exits 0 when
 *     `PR_NUMBER` is unset (pre-push, local dev), so the exemption stands
 *     unverified there. CI always sets it; this is a property of where the
 *     check runs, not of this module.
 */

import { type AnchorField, anchoredRegionBounds } from '@attalabs/aeg-core'
import { maskCode, maskDetailsBlocks } from '@attalabs/aeg-forge-state/strip-code'
import { EVIDENCE_SUMMARY_PREFIX } from '../lib/numstat'

// Zero-width and other Unicode default-ignorable characters — security review
// round 4 (PR #147) found one embedded inside an otherwise-recognized token
// ("te" + U+200B + "sts") defeats regex matching regardless of what the regex
// is looking for, and the same risk applies to the masking boundaries
// themselves: a fence marker, an `AEG:*` tag. Stripped from the WHOLE body
// once, here, before any masking or tokenizing. Written as escape sequences,
// deliberately, never as literal characters in this source file — an actual
// zero-width character sitting in this regex literal would be exactly as
// invisible and unauditable here as the bypass it exists to close. U+200B
// ZWSP, U+200C ZWNJ, U+200D ZWJ, U+2060 word joiner, U+FEFF BOM.
export const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g

// A short list of named HTML entities a PR body could plausibly carry (GitHub
// renders raw HTML in markdown) that would otherwise wrap a masking boundary
// character — a fence backtick, an anchor's `<`/`>` — invisibly to every mask
// below (round 4, finding 4).
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
 * Normalise a PR body the way every consumer of these anchors must.
 *
 * Zero-width stripping and named-entity decoding, in that order, before any
 * masking or anchor lookup. A consumer that skips this stage does not merely
 * miss a character class — it resolves a DIFFERENT region, which is the whole
 * defect of Issue #189.
 */
function normalizeBody(rawBody: string): string {
  return decodeNamedEntities(rawBody.replace(ZERO_WIDTH, ''))
}

/**
 * The masking every anchor lookup shares: code first, then `<details>`.
 *
 * The order is load-bearing and is `maskDetailsBlocks`'s own documented
 * requirement — a `<details>` tag quoted inside a fence or an inline span must
 * already be inert filler before the details scanner sees it, or a decoy tag
 * could open or close a fake region.
 *
 * Both maskers are same-length, index-preserving, by their own contract. That
 * is what lets a region be *located* on the mask and *sliced* from the
 * normalised text — the discipline `maskCode`'s docstring states as "the
 * returned region is always sliced from the original, never from the mask".
 */
function buildAnchorLookupMask(body: string): string {
  return maskDetailsBlocks(maskCode(body))
}

/**
 * The normalised body and its anchor-lookup mask, derived together, once.
 *
 * Nominal by construction: `raw` is `private`, so no object literal and no
 * other class satisfies this type, and the constructor is `private`, so
 * `ScanContext.from` is the only way to build one. See the module doc for what
 * that does and does not close.
 */
export class ScanContext {
  private constructor(
    private readonly raw: string,
    /** The body after `normalizeBody` — what a region's text is sliced from. */
    readonly normalised: string,
    /** The same text with code and `<details>` blanked, offsets preserved — what a region is located in. */
    readonly masked: string
  ) {}

  static from(rawBody: string): ScanContext {
    const normalised = normalizeBody(rawBody)
    return new ScanContext(rawBody, normalised, buildAnchorLookupMask(normalised))
  }

  /**
   * Would a resolver reading the UN-normalised body agree with this context
   * about whether `field` is anchored at all?
   *
   * The writer (`vinaya pr report --write`) must splice into the raw body it
   * was handed, so it cannot use this context's offsets — normalisation is not
   * length-preserving. What it can do is refuse when the two disagree, which
   * is exactly the divergence this module exists to close, checked from the
   * one side that cannot adopt the shared offsets.
   */
  rawResolutionAgrees(field: AnchorField): boolean {
    const rawHasPair = anchoredRegionBounds(this.raw, field) !== null
    return rawHasPair === (anchoredRegionBounds(this.masked, field) !== null)
  }
}

export type ResolvedRegion = {
  /** The region's text, sliced from the normalised body — fenced content intact. */
  region: string
  /** The same span sliced from the mask — code and `<details>` blanked, offsets identical. */
  maskedRegion: string
}

/**
 * The one resolver. Locate the pair in the mask, slice both views.
 *
 * Every previous fix made `check-evidence-fresh` agree with `body-bare-digits`
 * at one more layer — the same masker, then the same masker input, then the
 * same normalisation — and each time the disagreement reappeared one stage
 * away. Agreement by convention cannot terminate; agreement by construction
 * can, because there is one function and it takes a `ScanContext`.
 *
 * Locating in `ctx.masked` rather than `ctx.normalised` is not incidental: it
 * is what makes a decoy anchor pair inside a fenced block or the collapsed
 * reference-brief `<details>` block lose to the real one, for both consumers
 * at once. `check-evidence-fresh` resolved on the raw body until now and would
 * have verified such a decoy while `body-bare-digits` exempted the real block.
 *
 * Three outcomes, deliberately distinct:
 *   - `null` — no pair anywhere. The anchor is opt-in; a body that has not
 *     adopted it is not broken by not adopting it.
 *   - `'hidden'` — a pair survives code-masking but not `<details>`-masking,
 *     so it sits inside a collapsed block. `body-bare-digits` blanks every
 *     digit in there regardless, and nothing can verify what it claims.
 *     "Unverifiable" and "not adopted" must not be handled the same way.
 *   - a `ResolvedRegion` — the real pair, in both views, at the same offsets.
 */
export function resolveAnchoredRegion(ctx: ScanContext, field: AnchorField): ResolvedRegion | 'hidden' | null {
  const bounds = anchoredRegionBounds(ctx.masked, field)
  if (bounds === null) {
    // `anchoredRegionBounds` code-masks internally, so a pair found here but
    // not above survived `maskCode` and was removed by `maskDetailsBlocks`.
    return anchoredRegionBounds(ctx.normalised, field) !== null ? 'hidden' : null
  }
  return {
    region: ctx.normalised.slice(bounds.innerStart, bounds.innerEnd),
    maskedRegion: ctx.masked.slice(bounds.innerStart, bounds.innerEnd)
  }
}

/**
 * The index of the `Summary:` line `check-evidence-fresh` compares, or `null`.
 *
 * Selected from the MASKED view on purpose, so a `Summary:` inside the Group B
 * fence or a `<details>` block is blank filler and can never be the one
 * compared — the same "locate on the mask, slice from the normalised body"
 * discipline `resolveAnchoredRegion` uses, applied one level down.
 *
 * Column 0, case-sensitive, exactly the shape `buildBlockInner` emits. The
 * line's VALUE is emitted inside an inline code span, so `body-bare-digits`
 * needs no exemption for it at all and does not call this — a looser spelling
 * here would widen nothing.
 */
export function summaryLineIndex(maskedRegion: string): number | null {
  const index = maskedRegion.split('\n').findIndex((line) => line.startsWith(EVIDENCE_SUMMARY_PREFIX))
  return index === -1 ? null : index
}
