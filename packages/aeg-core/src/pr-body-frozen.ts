/**
 * The `pr-body-frozen` check (task 5, #378). Mechanizes the frozen-body rule
 * task 4 (`aeg-root/roles/developer.md` § "PR body — canonical form") already
 * states in prose: the PR body is written once at open and never hand-edited
 * again, except the `AEG:EVIDENCE` regeneration and one appended `AEG:TOKENS`
 * row. Pure — no `fs`, no `gh`/`git`.
 *
 * Design (why not read the forge's own edit history): GitHub's
 * `userContentEdits` nodes hold whole-body snapshots, and the body's
 * CREATION state is not among them — a hand edit made before the first
 * recorded edit is invisible to that API. Verified live against a real PR:
 * three edit nodes, each a full body, no creation node. So this check does
 * not read edit history at all. Instead, `vinaya pr create` computes
 * `authoredRegionHash` of the body it is about to send and posts it in one
 * PR comment under `renderBodyHashMarker` at open time. This check re-reads
 * that comment, recomputes the same hash from the LIVE body, and compares.
 *
 * `authoredRegion` strips every `ANCHOR_FIELDS` region (outer bounds — the
 * markers themselves plus their content) and normalises every `- [x]`/
 * `- [X]` checkbox to `- [ ]`, so:
 *   - `AEG:EVIDENCE` regeneration after a push does not break the hash
 *     (the field is stripped).
 *   - A re-entry's appended `AEG:TOKENS` row does not break the hash (the
 *     field is stripped — `TOKENS` joined `ANCHOR_FIELDS` in this same task,
 *     see `anchored-region.ts`'s doc comment for why the registry widened
 *     rather than gaining a second, parallel field list).
 *   - A Principal ticking a `[principal]` box in an unanchored Test Plan
 *     section does not break the hash (checkbox state is normalised away).
 * Everything else — the Summary prose, the `<details>` reference-brief
 * block (deliberately NOT stripped; it is authored text and must be frozen
 * too), the Scope paragraph, the Tier line outside its anchor when unanchored
 * — is compared verbatim.
 */

import { createHash } from 'node:crypto'
import { ANCHOR_FIELDS, anchoredRegionBounds } from './anchored-region'
import { isPrincipal } from './waiver-label'

/**
 * The one marker grammar both the writer (`vinaya pr create`) and the reader
 * (this check) use: `<!-- aeg:body-hash:<hex> -->`, a 64-character lowercase
 * sha256 hex digest. Lowercase `aeg:` (unlike the `AEG:<FIELD>` anchors) is
 * deliberate — this marker is never a gate-read body FIELD, just a stamp a
 * tool posts and a tool reads; nothing about it belongs in `ANCHOR_FIELDS`.
 */
export const BODY_HASH_MARKER_PATTERN = /<!--\s*aeg:body-hash:([0-9a-f]{64})\s*-->/i

/** Renders the marker for `hash` — the ONLY place the literal grammar is written, mirrored by `BODY_HASH_MARKER_PATTERN` for reading it back. */
export function renderBodyHashMarker(hash: string): string {
  return `<!-- aeg:body-hash:${hash} -->`
}

const CHECKBOX_TICK = /^([-*]\s+)\[[xX]\]/gm

/**
 * The body with every `ANCHOR_FIELDS` region removed by outer bounds (marker
 * comments and content both) and every ticked checkbox normalised to
 * unticked. Recomputes bounds fresh after each removal since prior removals
 * shift indices — cheap at PR-body scale, and it means field order in the
 * body never matters.
 */
export function authoredRegion(body: string): string {
  let result = body
  for (const field of ANCHOR_FIELDS) {
    const bounds = anchoredRegionBounds(result, field)
    if (bounds) {
      result = result.slice(0, bounds.outerStart) + result.slice(bounds.outerEnd)
    }
  }
  return result.replace(CHECKBOX_TICK, '$1[ ]')
}

/** sha256 hex digest of `authoredRegion(body)`. */
export function authoredRegionHash(body: string): string {
  return createHash('sha256').update(authoredRegion(body), 'utf8').digest('hex')
}

export type PrBodyFrozenComment = { body: string; author: string | null }

export type PrBodyFrozenStatus = 'pass' | 'fail' | 'info'

export type PrBodyFrozenResult = { status: PrBodyFrozenStatus; errors: string[] }

/**
 * Finds the FIRST marker comment authored by an allowlisted principal — a
 * marker from a non-allowlisted author is ignored (grandfathering an
 * attacker-posted decoy marker would let them pin an arbitrary hash and mask
 * a real edit). `pr create` posts this comment under the same login that
 * opened the PR, which the review-gate's own trust model already treats as
 * a principal-equivalent write path.
 */
function findMarker(comments: readonly PrBodyFrozenComment[], principalAllowlist: readonly string[]): string | null {
  for (const comment of comments) {
    if (!isPrincipal(comment.author, principalAllowlist as string[])) continue
    const match = BODY_HASH_MARKER_PATTERN.exec(comment.body)
    if (match) return (match[1] as string).toLowerCase()
  }
  return null
}

/**
 * `info`: no marker comment from an allowlisted author — this PR predates
 * `pr-body-frozen` (every PR open before this shipped has none) or was
 * opened by a non-principal flow. Never a failure; grandfathered.
 *
 * `pass`/`fail`: a marker exists — recompute `authoredRegionHash` of the
 * live body and compare.
 */
export function checkPrBodyFrozen(opts: {
  body: string
  comments: readonly PrBodyFrozenComment[]
  principalAllowlist: readonly string[]
}): PrBodyFrozenResult {
  const marker = findMarker(opts.comments, opts.principalAllowlist)
  if (marker === null) {
    return {
      status: 'info',
      errors: [
        'pr-body-frozen: no `aeg:body-hash` marker comment from an allowlisted author — grandfathered (this PR predates the check, or was not opened via `vinaya pr create`). Not a failure.'
      ]
    }
  }

  const live = authoredRegionHash(opts.body)
  if (live === marker) {
    return { status: 'pass', errors: [] }
  }

  return {
    status: 'fail',
    errors: [
      `pr-body-frozen: the PR body's authored region no longer matches the hash posted at open (recorded ${marker}, live ${live}). The body is frozen at open — a Developer answers review findings with commits and a round comment, never a body edit (except the AEG:EVIDENCE regeneration and one appended AEG:TOKENS row, both of which this check already tolerates).`
    ]
  }
}
