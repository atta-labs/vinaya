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
 * Base identity (`control-store-v1` task 5, `#555`, O1). The manifest now
 * carries `baseSha` — the base commit the round's candidate was judged
 * against — the field `review-validity-v1` task 4 deliberately deferred until
 * `control-store-v1` landed a durable home for it (that store is now built;
 * see `packages/aeg-core/src/control-store/`). Its acceptance is BOUNDED, not
 * a sixth always-checked equality (Traps to avoid: "same patch text on a new
 * base is not automatically equivalent"; "preserve the existing comparison
 * function ownership; explicitly document any narrowed acceptance"):
 *
 *   - When the candidate binds by an EXACT head sha, the base is required to
 *     match too — a base-only change (identical candidate, moved base) now
 *     INVALIDATES where it silently kept before. This is the one narrowed
 *     acceptance this task documents: an exact-head match no longer carries a
 *     verdict across a base move.
 *   - When the candidate binds by PATCH IDENTITY (a genuine equivalent rebase
 *     — the diff itself proven byte-identical), a base move is TOLERATED,
 *     exactly as the rebase-equivalence rule already allowed (`loop.md`, "The
 *     same-patch rebase equivalence, and its limit"). The patch is what the
 *     reviewer judged; the base is only where it sat. CI at the new head, which
 *     the gate already requires green, remains the guard for a semantic
 *     conflict a moved base could hide — unchanged by this task.
 *
 * Patch identity is NOT a stored field here — it is a property of a PAIR of
 * heads (the judged one, the current one), never of one manifest alone, so
 * `compareManifest` accepts an optional `patchIdOf` and resolves it for both
 * sides at comparison time, exactly as `review-gate.ts` already did before
 * this task.
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
 * (`codeReviewThreshold`, `securityThreshold`, then `maxRounds`) so two
 * callers resolving the identical `ReviewPolicy` value always agree on its
 * digest regardless of how they built the object literal.
 *
 * `maxRounds` — the incoming round-policy field (`control-store-v1` task 5,
 * `#555`, O1; Traps to avoid: "include the incoming round-policy field in the
 * relevant configuration identity") — is part of the digest so the policy
 * identity a verdict binds against is the COMPLETE effective policy, not just
 * its two severity thresholds. A run whose round cap changed under a verdict
 * is a policy change the gate must see, the same as a threshold change. The
 * one-time cost is the same fail-closed transition every other field in this
 * family already paid: a verdict cast before this field entered the digest
 * carries the old digest and needs one fresh review round.
 */
export function policyDigest(policy: ReviewPolicy): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        codeReviewThreshold: policy.codeReviewThreshold,
        securityThreshold: policy.securityThreshold,
        maxRounds: policy.maxRounds
      })
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
  /** The candidate identity — the round's judged head (`control-store-v1` task 5, `#555`, O1: "base and candidate identity"). */
  headSha: string
  /**
   * The base identity — the base commit the candidate was judged against
   * (`control-store-v1` task 5, `#555`, O1). `null` exactly when no base is
   * resolvable to bind against (a caller with no git/base context, or a
   * pre-cutover verdict that echoed no `Judged base:` line) — the same
   * "nothing to bind against" shape `briefHash`/`objectivesVersion` already
   * carry, keyed on the CURRENT side so a real base still fails a null echo.
   */
  baseSha: string | null
  briefHash: string | null
  objectivesVersion: string | null
  rulingOrdinal: number
  policyDigest: string
}

export type ReviewInputManifestFacts = {
  headSha: string
  /** The base commit the candidate is judged against (`#555`, O1) — `null` when the caller cannot resolve one, never a thrown refusal. */
  baseSha: string | null
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
    baseSha: facts.baseSha,
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
  /** `null` when no `Judged base:` line was found (`#555`, O1) — pre-cutover legacy stock, or a stripped line. */
  baseSha: string | null
  briefHash: string | null
  objectivesVersion: string | null
  rulingOrdinal: number | null
  policyDigest: string | null
}

/** `manifest`'s own fields, reshaped as an `EchoedManifest` — for a same-process comparison (the loop's pre-hold self-check) where the "echo" is simply the in-memory manifest a verdict was rendered from, never a round-trip through the rendered text. */
export function manifestAsEchoed(manifest: ReviewInputManifest): EchoedManifest {
  return {
    headSha: manifest.headSha,
    baseSha: manifest.baseSha,
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
 * True when the echoed base identity covers the current one (`#555`, O1).
 * `currentBase === null` skips the binding (no base resolvable to judge
 * against — the same "nothing to bind against" shape `isBoundToObjectives`/
 * `isBoundToBriefHash` use for their own current-side null, and what keeps
 * every caller that predates base identity, and every fixture that never sets
 * a base, unaffected). Against a REAL current base, a `null` echo (a verdict
 * that carried no `Judged base:` line — pre-cutover stock) is unbound, the
 * same fail-closed treatment `isBoundToBriefHash` gives a null echo against a
 * resolvable current hash — a one-time cost of one fresh review round, never
 * a permanent exemption. This is a plain equality; the BOUNDED part (base is
 * required only when the head bound by an exact sha, never on a proven patch-
 * identity rebase) lives in `compareManifest`, where both sides of the pair
 * are in view.
 */
export function isBoundToBase(echoed: { baseSha: string | null }, currentBase: string | null): boolean {
  if (currentBase === null) return true
  return echoed.baseSha === currentBase
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
 * True when the echoed policy digest covers the current one. `#478` round 4
 * (security MEDIUM): NEVER grandfathers a `null` echo, unlike a first read
 * of "a policy is ALWAYS resolvable, so grandfather on the echoed side
 * instead" might suggest — every other field in this family grandfathers
 * only when there is a genuine sentinel for "nothing to compare" on the
 * CURRENT side (`currentHash`/`currentVersion === null` for brief/
 * objectives, `currentOrdinal === 0` for rulings, each a real fact about
 * that PR/Issue that can itself change and un-grandfather the binding
 * later). A policy has no such sentinel: `currentDigest` is never null, so
 * a blanket "null echo always binds" never re-evaluates and can never
 * un-grandfather — exactly the asymmetry `isBoundToBriefHash`'s own doc
 * comment already warns against ("there is no partial-legacy stock to
 * grandfather on the echoed side: a `null` echo against a resolvable
 * current [value] is simply unbound"), just not yet applied here. A `null`
 * echo (a comment predating `Policy digest:` rendering, or one stripped of
 * the line) is simply unbound, the same as any other mismatch — the one-
 * time cost is that a PR opened before this task merged needs one fresh
 * review round, not a permanent exemption from the O5 guarantee.
 */
export function isBoundToPolicy(echoed: { policyDigest: string | null }, currentDigest: string): boolean {
  return echoed.policyDigest === currentDigest
}

export type ManifestBindingResult = {
  /** `true` iff every field below binds. */
  bound: boolean
  head: boolean
  /**
   * The bounded base-identity result (`#555`, O1) — `true` when the base is
   * satisfied under the acceptance rule, NOT a bare `isBoundTobase` equality:
   * a proven patch-identity rebase reports `true` here even across a base move
   * (the diff itself is what was judged), while an exact-head match across a
   * changed base reports `false`. `false` iff a base-only change (or a missing
   * base echo against a real current base) is what broke the binding.
   */
  base: boolean
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
  // The head/base pair, bound together under the acceptance rule (`#555`,
  // O1). An exact head sha is the same candidate — a base move under it is a
  // base-only change and must fail. A patch-identity match is a proven
  // equivalent rebase — the diff itself is byte-identical, so a base move is
  // tolerated (the reviewer judged the patch, not the base; CI at the new
  // head is the guard). `head` stays the whole "candidate covers current"
  // answer (either path), unchanged for every existing caller; `base` is the
  // separately-reported, bounded verdict on the base identity.
  const exactHead = isBoundToHead(echoed, current.headSha)
  const patchHead = isBoundByPatchIdentity(echoed, current.headSha, patchIdOf)
  const head = exactHead || patchHead
  const base = patchHead ? true : isBoundToBase(echoed, current.baseSha)
  const briefHashBound = isBoundToBriefHash(echoed, current.briefHash)
  const objectivesVersion = isBoundToObjectives(echoed, current.objectivesVersion)
  const rulingOrdinal = isBoundToRulings(echoed, current.rulingOrdinal)
  const policyDigestBound = isBoundToPolicy(echoed, current.policyDigest)
  return {
    bound: head && base && briefHashBound && objectivesVersion && rulingOrdinal && policyDigestBound,
    head,
    base,
    briefHash: briefHashBound,
    objectivesVersion,
    rulingOrdinal,
    policyDigest: policyDigestBound
  }
}
