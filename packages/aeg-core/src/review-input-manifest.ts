/**
 * The review-input manifest (`review-validity-v1` task 4, `#478`). One typed
 * snapshot of every fact a verdict is judged against — head, the frozen
 * brief's own hash, the objectives version, the newest ruling ordinal, and
 * the effective review policy's digest — built by the driver from forge
 * facts BEFORE reviewers are dispatched (`buildReviewInputManifest`), and
 * the one comparison (`compareManifest`) both the merge gate
 * (`review-gate.ts`'s `checkReviewGate`) and the loop's own publication
 * self-check (`apps/cli/src/lib/dev-review-loop.ts`) call to decide whether
 * a verdict still covers the current state of the world.
 *
 * Pure — no `fs`, no `fetch`, no `process.env`. `node:crypto`'s `createHash`
 * is used the same way `objectives.ts`/`premise-check.ts`/`claude-code-transcript.ts`
 * already do in this package: a deterministic digest is not I/O.
 *
 * Deliberately excludes base identity and a durable policy history — both
 * are named in the execution contract but deferred until `control-store-v1`
 * gives them somewhere durable to live (Traps to avoid: this task
 * consolidates what tasks 2 and 3 landed, it does not widen the binding).
 *
 * Patch identity is NOT a stored field here — it is a property of a PAIR of
 * heads (the judged one, the current one), never of one manifest alone, so
 * `compareManifest` accepts an optional `patchIdOf` and resolves it for both
 * sides at comparison time, exactly as `review-gate.ts` already did before
 * this task (Traps to avoid: do not change the meaning of the patch-identity
 * tolerance — a base that moved under an identical patch can still hide a
 * semantic conflict the earlier review could not have seen; CI at the new
 * head is the guard for that, unchanged by this task).
 */

import { createHash } from 'node:crypto'
import type { ReviewPolicy } from './review-policy'

/**
 * `sha256` of the frozen brief's own text as it appears posted, below its
 * header lines — moved here from `apps/cli/src/lib/dispatch-task.ts` (task 4,
 * `#478`, O1: one implementation, not two now that a pure-package caller
 * needs the identical fact). The hashed content is `brief + '\n'`, exactly
 * what `@attalabs/aeg-core`'s `frozenBriefContent`/`contentAfterNLines`
 * reconstruct from a live posted comment — computing the hash any other way
 * would make the writer and every reader of "the frozen brief's hash"
 * disagree on a real, once-posted comment.
 */
export function briefHash(brief: string): string {
  return createHash('sha256').update(`${brief}\n`).digest('hex')
}

/**
 * `sha256` of the effective review policy — one canonical field order
 * (`codeReviewThreshold` then `securityThreshold`) so two callers resolving
 * the identical `ReviewPolicy` value always agree on its digest regardless
 * of how they built the object literal.
 */
export function policyDigest(policy: ReviewPolicy): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ codeReviewThreshold: policy.codeReviewThreshold, securityThreshold: policy.securityThreshold })
    )
    .digest('hex')
}

/**
 * One review-input snapshot. `briefHash`/`objectivesVersion` are `null`
 * exactly when nothing is resolvable to bind against yet (no linked Issue,
 * no frozen brief, no `## Objectives` section) — the same "skip the
 * binding" meaning `objectivesVersion` already carried on `ReviewGateInput`
 * before this task. `rulingOrdinal`/`policyDigest` are never null: a PR
 * either has rulings or doesn't (`0` says so), and a policy is always
 * either configured or defaulted.
 */
export type ReviewInputManifest = {
  headSha: string
  briefHash: string | null
  objectivesVersion: string | null
  rulingOrdinal: number
  policyDigest: string
}

export type ReviewInputManifestFacts = {
  headSha: string
  /** The frozen brief's own text (already header-stripped, e.g. `resolveNewestFrozenBrief(...).content`), or `null` when none is resolvable for this task/PR — `briefHash` is `null` in that case, never a thrown refusal. */
  briefContent: string | null
  objectivesVersion: string | null
  rulingOrdinal: number
  policy: ReviewPolicy
}

/** The one builder — every call site that used to compute these facts as separate, ad hoc values now builds this instead. */
export function buildReviewInputManifest(facts: ReviewInputManifestFacts): ReviewInputManifest {
  return {
    headSha: facts.headSha,
    briefHash: facts.briefContent === null ? null : briefHash(facts.briefContent),
    objectivesVersion: facts.objectivesVersion,
    rulingOrdinal: facts.rulingOrdinal,
    policyDigest: policyDigest(facts.policy)
  }
}

/**
 * What a verdict/escalation comment echoes back — read off the rendered
 * text by the same extractors `compareManifest`'s two callers both use
 * (`extractCodeReviewVerdict`/`extractSecurityReviewVerdict`,
 * `verdict-extraction.ts`). `null` on any field means no structural line
 * for it was found in the comment's own read window — the pre-cutover
 * legacy shape for `headSha`/`objectivesVersion`/`rulingOrdinal`, and the
 * "this comment predates the feature" shape for `briefHash`/`policyDigest`,
 * which render unconditionally on every verdict from this task forward.
 *
 * Never trust an echoed value as provenance (Traps to avoid) — it is the
 * PARENT's own dispatch-time fact, stamped into the rendered comment and
 * read back only to confirm the comment still covers the CURRENT manifest.
 * A mismatch is reported; the echo itself never substitutes for a live
 * fact anywhere.
 */
export type EchoedManifest = {
  headSha: string | null
  briefHash: string | null
  objectivesVersion: string | null
  rulingOrdinal: number | null
  policyDigest: string | null
}

/** `manifest`'s own fields, reshaped as an `EchoedManifest` — for a same-process comparison (the loop's pre-hold self-check) where the "echo" is simply the in-memory manifest a verdict was rendered from, never a round-trip through the rendered text. */
export function manifestAsEchoed(manifest: ReviewInputManifest): EchoedManifest {
  return {
    headSha: manifest.headSha,
    briefHash: manifest.briefHash,
    objectivesVersion: manifest.objectivesVersion,
    rulingOrdinal: manifest.rulingOrdinal,
    policyDigest: manifest.policyDigest
  }
}

/**
 * True when `echoed.headSha` covers `headSha` — an exact match, or
 * `headSha` starting with `echoed.headSha` (the abbreviated-sha case).
 * `false` when `echoed.headSha` is `null` — an unbound verdict never counts
 * as covering anything. Moved here verbatim from `review-gate.ts`'s own
 * `isBoundToHead` (task 4, `#478`, O2 — one comparison, not two).
 */
export function isBoundToHead(echoed: { headSha: string | null }, headSha: string): boolean {
  if (!echoed.headSha) return false
  return headSha.toLowerCase().startsWith(echoed.headSha.toLowerCase())
}

/**
 * True when the judged head and the current head carry the SAME patch.
 * Fails closed on every uncertainty — `null` on either side is "git could
 * not answer", never "they match." Moved here verbatim from
 * `review-gate.ts`'s own `isBoundByPatchIdentity`.
 */
function isBoundByPatchIdentity(
  echoed: { headSha: string | null },
  headSha: string,
  patchIdOf?: (sha: string) => string | null
): boolean {
  if (patchIdOf === undefined || !echoed.headSha) return false
  const judged = patchIdOf(echoed.headSha)
  const current = patchIdOf(headSha)
  if (judged === null || current === null) return false
  return judged === current
}

/** A verdict covers the current head when its sha binds it, or its patch identity does. */
export function isBoundToPatch(
  echoed: { headSha: string | null },
  headSha: string,
  patchIdOf?: (sha: string) => string | null
): boolean {
  return isBoundToHead(echoed, headSha) || isBoundByPatchIdentity(echoed, headSha, patchIdOf)
}

/**
 * True when the echoed objectives version covers the current one.
 * `currentVersion === null` skips the binding entirely (nothing to judge
 * against). Moved here verbatim from `review-gate.ts`'s own
 * `isBoundToObjectives`.
 */
export function isBoundToObjectives(
  echoed: { objectivesVersion: string | null },
  currentVersion: string | null
): boolean {
  if (currentVersion === null) return true
  return echoed.objectivesVersion === currentVersion
}

/**
 * True when the echoed ruling ordinal covers the current newest one. `null`
 * on the echo (pre-cutover stock) binds only when `currentOrdinal` is `0`.
 * Moved here verbatim from `review-gate.ts`'s own `isBoundToRulings`.
 */
export function isBoundToRulings(echoed: { rulingOrdinal: number | null }, currentOrdinal: number): boolean {
  if (echoed.rulingOrdinal === null) return currentOrdinal === 0
  return echoed.rulingOrdinal === currentOrdinal
}

/**
 * True when the echoed brief hash covers the current one. `currentHash ===
 * null` skips the binding (no frozen brief resolvable for this task/PR at
 * all — the same "nothing to judge against" shape `isBoundToObjectives`
 * already uses for its own current-side null). Unlike objectives/ruling,
 * there is no partial-legacy stock to grandfather on the echoed side: a
 * `null` echo against a resolvable current hash is simply unbound.
 */
export function isBoundToBriefHash(echoed: { briefHash: string | null }, currentHash: string | null): boolean {
  if (currentHash === null) return true
  return echoed.briefHash === currentHash
}

/**
 * True when the echoed policy digest covers the current one. The skip
 * direction here is the mirror image of every other field: a policy is
 * ALWAYS resolvable (configured or defaulted), so the current side is never
 * null — the grandfathering is on the ECHOED side instead, `null` meaning
 * "this comment predates `Policy digest:` rendering at all" (every comment
 * this task renders carries the line unconditionally, so a `null` echo is
 * legacy stock, never a real omission).
 */
export function isBoundToPolicy(echoed: { policyDigest: string | null }, currentDigest: string): boolean {
  if (echoed.policyDigest === null) return true
  return echoed.policyDigest === currentDigest
}

export type ManifestBindingResult = {
  /** `true` iff every field below binds. */
  bound: boolean
  head: boolean
  briefHash: boolean
  objectivesVersion: boolean
  rulingOrdinal: boolean
  policyDigest: boolean
}

/**
 * The ONE comparison behind both the merge gate (`checkReviewGate`) and the
 * loop's own publication self-check (task 4, `#478`, O2) — reported field
 * by field so a caller can name exactly which fact drifted, the same way
 * `checkReviewGate`'s own `problems` array already does.
 */
export function compareManifest(
  echoed: EchoedManifest,
  current: ReviewInputManifest,
  patchIdOf?: (sha: string) => string | null
): ManifestBindingResult {
  const head = isBoundToPatch(echoed, current.headSha, patchIdOf)
  const briefHashBound = isBoundToBriefHash(echoed, current.briefHash)
  const objectivesVersion = isBoundToObjectives(echoed, current.objectivesVersion)
  const rulingOrdinal = isBoundToRulings(echoed, current.rulingOrdinal)
  const policyDigestBound = isBoundToPolicy(echoed, current.policyDigest)
  return {
    bound: head && briefHashBound && objectivesVersion && rulingOrdinal && policyDigestBound,
    head,
    briefHash: briefHashBound,
    objectivesVersion,
    rulingOrdinal,
    policyDigest: policyDigestBound
  }
}
