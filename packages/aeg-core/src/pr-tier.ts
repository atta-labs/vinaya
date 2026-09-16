/**
 * PR tier derivation and the docs-gate override check. Pure — takes the diff,
 * PR body, and env-derived strings as explicit parameters. The original
 * `scripts/verify-docs.ts` read `process.env.PR_BODY` / `OVERRIDE_DOCS` /
 * `PR_LABELS` directly inside these functions; that hidden I/O is removed
 * here — the caller (the CLI shim) reads env once and passes the values in.
 */

import { hasLabel, label } from '@attalabs/aeg-forge-state'
import { anchoredRegion } from './anchored-region'
import { isDocFile, isSpecFile } from './file-classify'

/**
 * Derive a tier from the changed-file list when no `Tier:` field is in the PR body.
 *
 * Rules (in priority order):
 *   1. Spec or doc file in diff   → Tier 1
 *   2. Otherwise (code/config…)   → Tier 0
 *
 * A frozen archive carries no tier signal: nothing reads it, so touching one
 * says nothing about a change's impact.
 */
export function deriveTierFromDiff(changed: string[]): 0 | 1 {
  if (changed.some((p) => isSpecFile(p) || isDocFile(p))) return 1
  return 0
}

/**
 * Read the `Tier:` field from the PR body.
 *
 * Tolerates the three markdown shapes the field appears in:
 *   - plain:        `Tier: 3`
 *   - bold colon:   `**Tier:** 3`   (the `**` wraps `Tier:` including the colon)
 *   - bold label:   `**Tier**: 3`   (the `**` wraps only `Tier`)
 *
 * The field may appear inline in a metadata line (e.g.
 * `Tranche: x · Task: 1 · **Tier:** 3 · Project: y`), so it is NOT anchored
 * to line-start. Returns null when no Tier field is present at all — the caller
 * decides what a missing tier means (PR mode treats it as an explicit error,
 * NOT a silent default).
 *
 * When the body carries an `AEG:TIER` anchor pair (`anchored-region.ts`,
 * task 30), the same regex runs exclusively inside that pair — a `Tier:`
 * mention anywhere else (a pasted reference brief, a quoted example) is
 * ignored. Bodies without the pair parse exactly as before.
 */
/**
 * The exact `Tier:` field grammar, exported so a consumer that needs the
 * MATCH itself (not just the parsed number) — `body-bare-digits`, which
 * needs to know precisely which substring is the field's real value so it
 * can exempt exactly that and nothing appended after it — reuses this one
 * definition rather than a second regex that could silently drift from it.
 * An optional bold-open, the word Tier, an optional bold-close, a colon, an
 * optional bold-close (covers `**Tier:**`), optional space, then the digit.
 */
export const TIER_FIELD = /(\*\*)?\s*Tier\s*(\*\*)?\s*:\s*(\*\*)?\s*([013])\b/i

export function readTierFromPrBody(prBody: string): 0 | 1 | 3 | null {
  const searchIn = anchoredRegion(prBody, 'TIER') ?? prBody
  const m = searchIn.match(TIER_FIELD)
  if (!m) return null
  const t = Number(m[4])
  return t === 0 || t === 1 || t === 3 ? (t as 0 | 1 | 3) : null
}

/**
 * The floor-raise combinator: a declared tier is
 * never lowered, only raised to the mechanically-derived floor when that
 * floor is higher — a Planner's judgment is never silently overridden by a
 * derivation that cannot see it. `declared: null` means the source (an
 * Issue, a PR body) declared no `Tier:` field at all, or an invalid one —
 * the derived floor is the only signal, same as before this combinator
 * existed. `derivedFloor` never exceeds `1` (`deriveTierFromDiff`'s own
 * range) — Tier 3 only ever reaches the result by way of `declared`, never
 * by derivation.
 */
export function applyTierFloor(declared: 0 | 1 | 3 | null, derivedFloor: 0 | 1): 0 | 1 | 3 {
  if (declared === null) return derivedFloor
  return declared >= derivedFloor ? declared : derivedFloor
}

/**
 * The body token that activates the override — the label name in brackets, so
 * the two spellings cannot drift. Built from the code-owned vocabulary rather
 * than written as a literal: `override:docs` was the one §14 system
 * label the namespace migration missed, precisely because it lived here as a
 * bare string that no label-family grep looked for.
 */
const OVERRIDE_BODY_TOKEN = `[${label('override-docs')}]`

export function overrideActive(opts: { overrideDocsEnv?: string; prLabels?: string; prBody?: string }): boolean {
  if (opts.overrideDocsEnv === '1') return true
  const labels = (opts.prLabels || '').split(',').map((s) => s.trim())
  if (hasLabel('override-docs', labels)) return true
  if ((opts.prBody || '').includes(OVERRIDE_BODY_TOKEN)) return true
  return false
}
