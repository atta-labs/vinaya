/**
 * `dev-review-loop`'s publication concern — posting a round's already-held verdicts and summary to the
 * forge, idempotently, with a policy self-check before either verdict counts
 * as publishable (O3: a reviewer's own APPROVE/PASS never overrides the
 * evaluator). Moved out of `apps/cli/src/lib/dev-review-loop.ts` verbatim;
 * `dev-review-loop.ts` stays the composition root, re-exporting every name
 * below under the same path it always had.
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  compareManifest,
  defaultControlStoreDeps,
  type EchoedManifest,
  evaluateCodeReview,
  evaluateSecurityReview,
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  type Journal,
  type ManifestBindingResult,
  renderSummary,
  type ReviewInputManifest,
  type ReviewPolicy,
  type VerdictExtraction
} from '@attalabs/aeg-core'
import { principalBodies } from '../../commands/review-post.js'
import { controlStoreRoot, createEffectExecutor, sha256Hex } from '../effects.js'
import { reconcileGhComment } from '../forge-write.js'
import { sh } from './gate-reading.js'
import { markerComments, principalAllowlist } from './developer-dispatch.js'
import { heldVerdictPath, readIfExists } from './reviewer-dispatch.js'

type ForgeEffectRecord = { effectId: string; status: 'started' | 'posted'; url?: string }

function forgeEffectPath(root: string, task: number, key: string): string {
  return join(root, 'dev-review-loop', String(task), `effect-${key}.json`)
}

function readForgeEffect(path: string): ForgeEffectRecord | null {
  const raw = readIfExists(path)
  if (!raw) return null
  try {
    return JSON.parse(raw) as ForgeEffectRecord
  } catch {
    return null
  }
}

function writeForgeEffect(path: string, record: ForgeEffectRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record), 'utf8')
}

/**
 * Posts through `poster` at most once per `key`: an effect id is recorded in
 * the outbox as `started` before `poster` runs, then overwritten as `posted`
 * (with the URL `poster` returned) right after — mirroring `dispatch.ts`'s
 * own effect-id-before/checked-after discipline (its doc comment,
 * `hasOwnDispatchLine`), adapted here to a comment post rather than a
 * process spawn since `DevReviewLoopEvent` carries no `effect_id` field to
 * key on (`hasOwnLoopLine`'s own doc comment, above). A rerun that finds an
 * already-`posted` record returns its recorded URL without calling `poster`
 * again — O1's "nothing is posted twice on a rerun."
 */
export function postForgeEffectOnce(root: string, task: number, key: string, poster: () => string): string {
  const path = forgeEffectPath(root, task, key)
  const existing = readForgeEffect(path)
  if (existing?.status === 'posted' && existing.url) return existing.url
  const effectId = existing?.effectId ?? randomUUID()
  writeForgeEffect(path, { effectId, status: 'started' })
  const url = poster()
  writeForgeEffect(path, { effectId, status: 'posted', url })
  return url
}

/**
 * Posts `body` on `prNumber` through the shared `EffectExecutor` (Issue
 * #552), keyed by `key` — O1's "persist the effect identity before the
 * write," O2's "reconcile against the remote before a retry," in place of
 * `postForgeEffectOnce`'s own local `'posted'` flag, which cannot tell a
 * confirmed post apart from one whose confirmation was lost to a crash.
 * `inputVersion` is this round: a rerun of the SAME round posting the SAME
 * body reduces to the SAME identity, so a genuine rerun still posts nothing
 * twice, exactly as `postForgeEffectOnce` guaranteed.
 */
function postPrCommentOnce(task: number, round: number, key: string, prNumber: number, body: string): string {
  const deps = defaultControlStoreDeps(controlStoreRoot)
  const executor = createEffectExecutor(deps, task, `dev-review-loop:${task}:${key}`)
  return executor.execute({
    key,
    identity: {
      operation: 'pr-comment',
      target: `pr:${prNumber}`,
      inputVersion: round,
      payloadDigest: sha256Hex(body)
    },
    poster: () => postPrComment(prNumber, body),
    reconcile: reconcileGhComment('pr', String(prNumber))
  })
}

/**
 * Raw `gh pr comment`, no marker line — deliberately NOT `postMarkedComment`
 * (`./forge-write.js`): that function forces a marker onto line 1, which
 * shifts every line of a rendered verdict down by one and pushes a present
 * `Objectives version:` line outside `extractCodeReviewVerdict`/
 * `extractSecurityReviewVerdict`'s five-line read window
 * (`verdict-extraction.ts`'s own `firstFiveLines`). Same temp-file-then-`gh
 * comment` shape `postMarkedComment` and `review-post.ts`'s own (unexported)
 * `postComment` both use.
 */
function postPrComment(pr: number, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-dev-review-loop-comment-'))
  const tmp = join(dir, 'comment.md')
  writeFileSync(tmp, body, 'utf8')
  try {
    return execFileSync('gh', ['pr', 'comment', String(pr), '--body-file', tmp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Attributed bodies only — a comment whose author does not resolve as a
 * principal is not evidence that THIS run's own post landed (a security
 * review finding: this is the same untrusted-comment class a related finding
 * closed for `fetchRulings`/`fetchFrozenBrief`, reintroduced here). Reuses
 * `review-post.ts`'s `principalBodies` — the exact filter `checkReviewGate`
 * itself applies before calling either extractor — rather than a second,
 * parallel derivation.
 */
function fetchAllPrCommentBodies(pr: number): string[] {
  const out = sh('gh', ['pr', 'view', String(pr), '--json', 'comments'])
  return principalBodies(markerComments(out), principalAllowlist())
}

export type PublishInput = {
  task: number
  round: number
  prNumber: number
  /** The round's judged head — every posted verdict is expected to bind to this, re-verified after each post. */
  expectedHead: string
  journal: Journal
  /** Which severities block is repository policy — the SAME resolved value `buildVerdictFromReport` derived this round's held verdicts under. */
  policy: ReviewPolicy
  /**
   * The manifest this round was dispatched against (task 5,
   * `#555`, O3) — `compareManifest`, the SAME comparison the merge gate and
   * the driver's own pre-hold self-check call, is applied here too against
   * each posted verdict's echoed lines, so publication binds on EVERY field
   * (base, brief, objectives, ruling, policy), not just the head it already
   * re-checked. A posted verdict that does not fully bind is refused, never
   * published — the same "nothing published against state it never covered"
   * invariant, now field-complete rather than head-only.
   */
  manifest: ReviewInputManifest
}

/** The field names `compareManifest` reports as unbound — `[]` when everything binds. */
export function unboundFields(binding: ManifestBindingResult): string[] {
  const unbound: string[] = []
  if (!binding.head) unbound.push('head')
  if (!binding.base) unbound.push('base')
  if (!binding.briefHash) unbound.push('brief hash')
  if (!binding.objectivesVersion) unbound.push('objectives version')
  if (!binding.rulingOrdinal) unbound.push('ruling ordinal')
  if (!binding.policyDigest) unbound.push('policy digest')
  return unbound
}

/**
 * The echoed manifest a posted verdict re-parses to, compared against the
 * round's own manifest with the SAME `compareManifest` the gate uses (`#555`,
 * O3). Never trusts the echo as provenance — it is read back from the posted
 * text only to confirm the comment still covers the manifest the round was
 * dispatched with (`patchIdOf` is deliberately not supplied here: a
 * just-posted verdict must bind by exact identity, never rely on a rebase
 * tolerance that only makes sense across a real head move at the gate).
 */
export function bindingOfPosted(posted: VerdictExtraction, manifest: ReviewInputManifest): ManifestBindingResult {
  const echoed: EchoedManifest = {
    headSha: posted.headSha,
    baseSha: posted.baseSha,
    briefHash: posted.briefHash,
    objectivesVersion: posted.objectivesVersion,
    rulingOrdinal: posted.rulingOrdinal,
    policyDigest: posted.policyDigest
  }
  return compareManifest(echoed, manifest)
}

/**
 * O1: at green, posts the two verdicts `writeHeldVerdict` already wrote for
 * `round`, then one summary comment from `renderSummary` — each through
 * `postForgeEffectOnce`'s idempotent forge-write, each re-read afterward
 * through the SAME extractors the merge gate calls (`extractCodeReviewVerdict`/
 * `extractSecurityReviewVerdict`), confirming the posted comment resolves
 * cleanly to `expectedHead`. The summary is checked BEFORE it is posted,
 * never after: `renderSummary`'s own doc comment guarantees no `VERDICT:`/
 * `Judged head:`/`Objectives version:` line, but this is re-verified live
 * against the two real extractors rather than trusted from that comment
 * alone (Traps to avoid) — a summary that parses as a verdict is refused,
 * not posted.
 */
export function publishRound(root: string, input: PublishInput): void {
  const { task, round, prNumber, expectedHead, policy, manifest } = input
  const reviewerBody = readIfExists(heldVerdictPath(root, task, round, 'reviewer'))
  const securityBody = readIfExists(heldVerdictPath(root, task, round, 'security'))
  if (!reviewerBody || !securityBody) {
    throw new Error(
      `publishRound: missing held verdict file(s) for task ${task} round ${round} — writeHeldVerdict should have written both before assessRound ever returned 'publish'.`
    )
  }

  postPrCommentOnce(task, round, `${round}-reviewer-verdict`, prNumber, reviewerBody)
  const postedReviewer = extractCodeReviewVerdict(fetchAllPrCommentBodies(prNumber))
  if (postedReviewer.danglingNote || postedReviewer.headSha !== expectedHead) {
    throw new Error(
      `publishRound: posted reviewer verdict does not re-parse clean through extractCodeReviewVerdict bound to ${expectedHead}: ${postedReviewer.danglingNote ?? `headSha read back as ${String(postedReviewer.headSha)}`}`
    )
  }
  // O3: the SAME `compareManifest` binding the gate applies — the posted
  // comment must cover every field of the round's manifest (base included),
  // not merely its head.
  const reviewerUnbound = unboundFields(bindingOfPosted(postedReviewer, manifest))
  if (reviewerUnbound.length > 0) {
    throw new Error(
      `publishRound: posted reviewer verdict does not bind to the round's manifest on: ${reviewerUnbound.join(', ')} — refusing to publish a verdict that does not cover the state it was dispatched against.`
    )
  }
  // O3: the reviewer's own posted APPROVE never overrides the evaluator —
  // re-evaluate the posted comment's own FINDINGS block against policy
  // before treating this round as publishable, mirroring the merge gate's
  // identical check (`checkReviewGate`) rather than trusting construction
  // alone.
  const postedReviewerPolicy = evaluateCodeReview(postedReviewer.findingSeverities, policy)
  if (postedReviewer.value === 'APPROVE' && postedReviewerPolicy.outcome === 'blocked') {
    throw new Error(
      `publishRound: posted reviewer verdict says APPROVE but carries a finding (${postedReviewerPolicy.blockingFindings.map((f) => f.severity).join(', ')}) at or above this repository's code-review policy threshold (${policy.codeReviewThreshold}) — refusing to publish.`
    )
  }

  postPrCommentOnce(task, round, `${round}-security-verdict`, prNumber, securityBody)
  const postedSecurity = extractSecurityReviewVerdict(fetchAllPrCommentBodies(prNumber))
  if (postedSecurity.danglingNote || postedSecurity.headSha !== expectedHead) {
    throw new Error(
      `publishRound: posted security verdict does not re-parse clean through extractSecurityReviewVerdict bound to ${expectedHead}: ${postedSecurity.danglingNote ?? `headSha read back as ${String(postedSecurity.headSha)}`}`
    )
  }
  const securityUnbound = unboundFields(bindingOfPosted(postedSecurity, manifest))
  if (securityUnbound.length > 0) {
    throw new Error(
      `publishRound: posted security verdict does not bind to the round's manifest on: ${securityUnbound.join(', ')} — refusing to publish a verdict that does not cover the state it was dispatched against.`
    )
  }
  const postedSecurityPolicy = evaluateSecurityReview(postedSecurity.findingSeverities, policy)
  if (postedSecurity.value === 'PASS' && postedSecurityPolicy.outcome === 'blocked') {
    throw new Error(
      `publishRound: posted security verdict says PASS but carries a finding (${postedSecurityPolicy.blockingFindings.map((f) => f.severity).join(', ')}) at or above this repository's security policy threshold (${policy.securityThreshold}) — refusing to publish.`
    )
  }

  const summary = renderSummary(input.journal)
  const summaryAsCodeReview = extractCodeReviewVerdict([summary])
  const summaryAsSecurity = extractSecurityReviewVerdict([summary])
  if (summaryAsCodeReview.danglingNote === null || summaryAsSecurity.danglingNote === null) {
    throw new Error(
      "publishRound: the rendered summary re-parses as a real verdict through the gate's own extractors — refusing to post it (a summary mistaken for a verdict decides a merge)."
    )
  }
  postPrCommentOnce(task, round, `${round}-summary`, prNumber, summary)
}
