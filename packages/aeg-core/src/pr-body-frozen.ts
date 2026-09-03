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
 *
 * **Line-ending and trailing-whitespace normalised before hashing, to
 * exactly one trailing newline** (round-2 ruling addendum 3, corrected by
 * addendum 4) — `vinaya pr create --body-file` hashes the body file as
 * written to disk, which `pr create`'s own writer always ends in exactly
 * one `\n`; `vinaya-checks.yml` re-reads the LIVE body via
 * `${{ github.event.pull_request.body }}`, which GitHub returns with NO
 * trailing newline at all. Same authored bytes, different hash, on every
 * PR opened from a body file — found live on `#393` (`99d2263a…` at open
 * vs `1547275f…` from CI). Addendum 3's first cut stripped trailing
 * whitespace entirely (no re-added newline) — that normalises the LIVE
 * side correctly but changes what the FILE side hashes to, so it can never
 * match a marker already posted by `pr create`'s own (unnormalised, but
 * always-one-`\n`) writer: every marker posted before this fix — this PR,
 * `#392`, everything since `#390` — would go permanently unmatchable.
 * Canonical form is instead "trimmed, then exactly one trailing newline":
 * `\r\n` → `\n` first (order matters: collapsing CRLF before trimming
 * trailing whitespace means a lone trailing `\r` left by a partial CRLF→LF
 * pass can never survive as significant), trailing whitespace stripped,
 * one `\n` appended back — which is a no-op on `pr create`'s own file-based
 * writes (already end in exactly one `\n`) and normalises the webhook's
 * newline-less payload up to the same form, so both sides converge on the
 * hash `pr create` already posted.
 */
export function authoredRegion(body: string): string {
  let result = body
  for (const field of ANCHOR_FIELDS) {
    const bounds = anchoredRegionBounds(result, field)
    if (bounds) {
      result = result.slice(0, bounds.outerStart) + result.slice(bounds.outerEnd)
    }
  }
  return `${result.replace(CHECKBOX_TICK, '$1[ ]').replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`
}

/** sha256 hex digest of `authoredRegion(body)`. */
export function authoredRegionHash(body: string): string {
  return createHash('sha256').update(authoredRegion(body), 'utf8').digest('hex')
}

/**
 * Rollout PR number. A PR numbered below this is grandfathered when no
 * marker comment exists — the whole corpus at rollout has none. A PR
 * numbered AT or ABOVE it is NOT: a missing marker there is a `fail`, not an
 * `info`. This closes the bypass an absence-only grandfather rule leaves
 * open — the marker comment is an ordinary PR comment, deletable by anyone
 * with comment-delete permission, and deleting it must not degrade a real,
 * post-rollout PR back into the grandfathered case.
 *
 * PR number, not creation date: numbers are assigned once, monotonically,
 * by the forge itself — never re-derived, never subject to a timestamp's
 * timezone/precision ambiguity. `392` is the first PR opened after this
 * task's own round-3 review landed; `#391` (already open, pre-dating this
 * rule) stays on the grandfathered side of the line without a collision.
 */
export const FROZEN_BODY_SINCE_PR = 392

export type PrBodyFrozenComment = { body: string; author: string | null; createdAt: string }

export type PrBodyFrozenStatus = 'pass' | 'fail' | 'info'

/** Which `fail` this is — the shim selects a different `agent_recovery_prompt` per reason (#355: a check's failure vocabulary must be bound to its recovery advice, never a single generic prompt reused across incompatible causes). */
export type PrBodyFrozenFailReason = 'mismatch' | 'no-marker-not-grandfathered'

export type PrBodyFrozenResult =
  | { status: 'pass'; errors: [] }
  | { status: 'info'; errors: string[] }
  | { status: 'fail'; reason: PrBodyFrozenFailReason; errors: string[] }

/**
 * Finds the NEWEST (by `createdAt`) marker comment authored by an
 * allowlisted principal — never the first one encountered in whatever order
 * the caller's fetch happened to return, and never the oldest. A marker
 * from a non-allowlisted author is ignored (grandfathering an
 * attacker-posted decoy marker would let them pin an arbitrary hash and
 * mask a real edit). `pr create` posts the original marker under the same
 * login that opened the PR, which the review-gate's own trust model already
 * treats as a principal-equivalent write path.
 *
 * Newest-wins (task 12, #387) — reversed from the original earliest-wins
 * rule so the frozen body has a door: `vinaya pr refreeze` (Principal-only,
 * gated on the same allowlist this function already filters by) posts a
 * fresh marker over an edited body, and that marker must be the one this
 * function returns from then on. Picking the earliest would make the door
 * a no-op — the original marker would win forever regardless of any later,
 * equally-allowlisted repost. Safety survives the reversal because the
 * FILTER, not the ordering, is what keeps a non-Principal edit from ever
 * winning: only an allowlisted author's marker is a candidate at all, so a
 * Developer's later marker (posted under a non-allowlisted identity) never
 * beats a Principal's earlier one — it is never a candidate in the first
 * place.
 */
function findMarker(comments: readonly PrBodyFrozenComment[], principalAllowlist: readonly string[]): string | null {
  let newest: { hash: string; createdAt: string } | null = null
  for (const comment of comments) {
    if (!isPrincipal(comment.author, principalAllowlist as string[])) continue
    const match = BODY_HASH_MARKER_PATTERN.exec(comment.body)
    if (!match) continue
    const hash = (match[1] as string).toLowerCase()
    if (newest === null || comment.createdAt > newest.createdAt) {
      newest = { hash, createdAt: comment.createdAt }
    }
  }
  return newest ? newest.hash : null
}

/**
 * `info`: no marker comment from an allowlisted author, and `prNumber` is
 * below `FROZEN_BODY_SINCE_PR` — this PR predates `pr-body-frozen`. Never a
 * failure; grandfathered.
 *
 * `fail` (`no-marker-not-grandfathered`): no marker comment, and `prNumber`
 * is at or above `FROZEN_BODY_SINCE_PR` — this PR was opened after the
 * check shipped and should carry a marker. Either it wasn't opened via
 * `vinaya pr create`, or the comment was deleted. There is no fix an agent
 * can apply: the open-time hash is unrecoverable (recomputing now would
 * hash whatever the body currently is, which is exactly the thing under
 * question), so this is a Principal adjudication, not a re-run.
 *
 * `pass`/`fail` (`mismatch`): a marker exists — recompute
 * `authoredRegionHash` of the live body and compare.
 */
export function checkPrBodyFrozen(opts: {
  body: string
  comments: readonly PrBodyFrozenComment[]
  principalAllowlist: readonly string[]
  prNumber: number
}): PrBodyFrozenResult {
  const marker = findMarker(opts.comments, opts.principalAllowlist)
  if (marker === null) {
    if (opts.prNumber < FROZEN_BODY_SINCE_PR) {
      return {
        status: 'info',
        errors: [
          `pr-body-frozen: no \`aeg:body-hash\` marker comment from an allowlisted author — grandfathered (PR #${opts.prNumber} is below FROZEN_BODY_SINCE_PR #${FROZEN_BODY_SINCE_PR}). Not a failure.`
        ]
      }
    }
    return {
      status: 'fail',
      reason: 'no-marker-not-grandfathered',
      errors: [
        `pr-body-frozen: no \`aeg:body-hash\` marker comment from an allowlisted author, and PR #${opts.prNumber} is at or above FROZEN_BODY_SINCE_PR #${FROZEN_BODY_SINCE_PR} — a missing marker is no longer grandfathered. The open-time hash is unrecoverable; the Principal adjudicates before merge.`
      ]
    }
  }

  const live = authoredRegionHash(opts.body)
  if (live === marker) {
    return { status: 'pass', errors: [] }
  }

  return {
    status: 'fail',
    reason: 'mismatch',
    errors: [
      `pr-body-frozen: the PR body's authored region no longer matches the hash posted at open or the most recent \`vinaya pr refreeze\` (recorded ${marker}, live ${live}). The body is frozen — a Developer answers review findings with commits and a round comment, never a body edit (except the AEG:EVIDENCE regeneration and one appended AEG:TOKENS row, both of which this check already tolerates). Only the Principal can move the baseline, via \`vinaya pr refreeze\`.`
    ]
  }
}
