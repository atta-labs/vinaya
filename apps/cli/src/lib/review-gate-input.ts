/**
 * The review gate's own input assembly — the one place a `ReviewGateInput` is
 * built for a real pull request, shared by every caller that needs the gate's
 * verdict.
 *
 * Two callers today, and the reason this is shared rather than copied: the
 * `review-gate` check (`checks/bin/check-review-gate.ts`, the thin adapter that
 * emits the check contract) and the dev-review-loop driver's own
 * "is this review concluded?" read (`dev-review-loop/journal-history.ts`). The
 * gate re-resolves repository policy and the principal allowlist from the
 * DEFAULT BRANCH's trust anchor (`loadTrustAnchorConfig`) and the branch's TRUE
 * head from the remote (`git ls-remote`, never `gh pr view`'s own `headRefOid`,
 * which can lag a push) — a second, hand-built copy of this assembly that read
 * the pull request's own checkout would let a change lower the threshold it is
 * judged against, so there is exactly one copy and both callers pass through
 * it. For the same reason the loop calls this and `checkReviewGate` in-process
 * rather than shelling out to `vinaya check review-gate`: a command never calls
 * a command.
 *
 * Failures are RETURNED, never thrown and never `process.exit`ed, because the
 * two callers owe different things on the same failure. The check must fail
 * closed — an unresolvable head, base, policy, objectives version or frozen
 * brief hash is a red `severity:infra` check, since each of those silently
 * `null`ed is a binding disarmed (the findings that established this are on the
 * individual resolvers below). The driver must degrade — its question is
 * whether a review has concluded, and a forge read that fails answers "not
 * concluded, keep going", never "crash the driver". `message` and
 * `agentRecoveryPrompt` therefore carry the check's own wording, and the check
 * is the caller that emits them.
 */

import { execFileSync } from 'node:child_process'
import {
  briefHash,
  checkReviewGate,
  extractIssue,
  isIssueNotFoundError,
  isWaiverLabelActorVerified,
  newestPrincipalRulingOrdinal,
  OBJECTIVES_SINCE_ISSUE,
  objectivesOf,
  objectivesVersion,
  resolveNewestFrozenBrief,
  resolveObjectivesSource,
  WAIVER_LABEL_REVIEW,
  type ReviewGateInput
} from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist, resolveReviewPolicy } from './config.js'
import { patchIdAt } from './patch-id.js'

export type PrView = {
  number: number
  comments: { body: string; author?: { login?: string } | null }[]
  labels: { name: string }[]
  headRefName: string
  headRefOid: string
  baseRefName: string
  body: string
}

/** One unresolvable input fact, in the `review-gate` check's own words — the check emits it; the driver reads it as "the gate could not be evaluated". */
export type ReviewGateInputFailure = {
  message: string
  agentRecoveryPrompt: string
}

export type ReviewGateInputAssembly =
  | { ok: true; input: ReviewGateInput }
  | { ok: false; failure: ReviewGateInputFailure }

function failure(message: string, agentRecoveryPrompt: string): { ok: false; failure: ReviewGateInputFailure } {
  return { ok: false, failure: { message, agentRecoveryPrompt } }
}

function fetchPr(prNumber: number): PrView | null {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'number,comments,labels,headRefName,headRefOid,baseRefName,body'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    return JSON.parse(out) as PrView
  } catch {
    return null
  }
}

/** `gh issue view <n> --json body --jq .body` — mirrors `verify-brief.ts`'s `fetchIssueBodyForObjectives`. */
function fetchIssueBodyForObjectives(issueNumber: number): string {
  return execFileSync('gh', ['issue', 'view', String(issueNumber), '--json', 'body', '--jq', '.body'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function fetchIssueCommentsForBrief(issueNumber: number): { body: string; author: string | null }[] {
  const out = execFileSync('gh', ['issue', 'view', String(issueNumber), '--json', 'comments'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const parsed = JSON.parse(out) as { comments: Array<{ body: string; author?: { login?: string } | null }> }
  return parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
}

type Resolved<T> = { ok: true; value: T } | { ok: false; failure: ReviewGateInputFailure }

/**
 * The frozen brief's own hash this PR is judged against — `null` in
 * exactly TWO cases: the PR closes no Issue (`extractIssue`,
 * resolved before any fetch), or that Issue's real, successfully-fetched
 * comment list carries no principal-authored frozen brief yet
 * (`resolveNewestFrozenBrief` returning `null` on genuine data, not on an
 * error). Every OTHER case — the fetch itself throwing (network error, `gh`
 * auth failure, malformed JSON) — is a returned failure the check fails
 * closed on (`severity:infra`, exit `1`), the identical fail-closed treatment
 * `resolveObjectivesVersion` already gives its own fetch failure, and for
 * the identical reason (a round-3 review finding): the prior version caught
 * every exception into `null`, and `isBoundToBriefHash` treats a `null`
 * current hash as "skip the binding" — collapsing "the fetch failed" and
 * "no brief was ever posted" into the same permissive skip let a transient
 * `gh` hiccup at merge time silently disarm the whole brief-hash freshness
 * check, passing a PR whose frozen brief was actually superseded. Never
 * invoked when `waived` is `true`, so the waiver's own escape hatch stays
 * reachable even though this fails closed (a MAJOR finding, reapplied here).
 */
function resolveBriefHash(pr: PrView, principalAllowlist: readonly string[]): Resolved<string | null> {
  const { issue } = extractIssue(pr.body)
  if (issue === null) return { ok: true, value: null }
  let comments: { body: string; author: string | null }[]
  try {
    comments = fetchIssueCommentsForBrief(issue)
  } catch (err) {
    if (isIssueNotFoundError(err)) {
      return failure(
        `review-gate severity:infra — Issue #${issue} does not resolve via \`gh issue view\` — cannot verify the brief-hash binding for a PR whose linked Issue no longer exists.`,
        `Restore Issue #${issue}, fix \`Closes #N\` to name a real Issue, or have a principal apply the \`vinaya/waiver:review\` label, then re-run \`vinaya check review-gate\`.`
      )
    }
    return failure(
      `review-gate severity:infra — could not fetch Issue #${issue}'s comments via \`gh issue view\` to resolve its frozen-brief hash: ${(err as Error).message}`,
      'Confirm `gh auth status` passes and the Issue number is correct, then re-run `vinaya check review-gate`.'
    )
  }
  const frozen = resolveNewestFrozenBrief(comments, principalAllowlist as string[])
  return { ok: true, value: frozen ? briefHash(frozen.content) : null }
}

/**
 * The current `objectivesVersion` this PR is judged against.
 * `null` is returned in exactly ONE case: this PR was never subject to the
 * objectives obligation at all — an Issue genuinely below
 * `OBJECTIVES_SINCE_ISSUE` (checked first, unconditionally, before any fetch
 * — see below), or no Issue at all with no `## Objectives` section in the
 * body either. `checkReviewGate` reads that `null` as "skip the objectives
 * binding entirely", which is only safe when nothing was ever there to bind.
 *
 * Every OTHER case — an Issue at/above the cutover that no longer resolves,
 * a fetch failure, or objectives text that exists but no longer PARSES
 * (Issue's or body's) — is a returned failure the check fails closed on
 * (`severity:infra`, exit `1`). A security review found the prior version
 * returning a silent `null` for the first two of those: falling through to
 * the body's own section (or straight to `null`) whenever the linked Issue
 * came back "not found", and swallowing a parse failure into `null` in both
 * the Issue and body branches. Since `isBoundToObjectives` treats a `null`
 * current version as an unconditional match, that silent `null` let anyone
 * who can edit or delete the LINKED ISSUE (not necessarily anyone with PR
 * push access) disarm the objectives-version binding for an
 * already-cast verdict after the fact — exactly the staleness the binding
 * exists to catch. `vinaya review post`'s `resolveObjectivesForPr` already
 * refuses to POST a new verdict in every one of these identical cases
 * (`no objectives to judge against`); this resolver refuses to COUNT an
 * existing one clean for the same cases, closing the gap rather than
 * mirroring it. The two resolvers' Issue-vs-cutover branch order is
 * identical too — the prior version's missing early pre-cutover return let
 * it fall through to the body's own section for a pre-cutover Issue, which
 * could resolve a non-null version `review post` never rendered a matching
 * line for, permanently failing the gate on an otherwise-legitimate PR (the
 * same review's MEDIUM finding).
 *
 * Never invoked when an actor-verified `vinaya/waiver:review` label is
 * present, precisely so this fail-closed path cannot make the waiver's own
 * escape hatch unreachable for exactly the case the waiver exists to rescue:
 * a linked Issue that got deleted or renumbered (a security-review MAJOR
 * finding).
 */
function resolveObjectivesVersion(pr: PrView): Resolved<string | null> {
  const { issue } = extractIssue(pr.body)
  const source = resolveObjectivesSource(pr.body, issue, OBJECTIVES_SINCE_ISSUE)

  if (source.kind === 'none') return { ok: true, value: null }

  if (source.kind === 'issue') {
    let issueBody: string
    try {
      issueBody = fetchIssueBodyForObjectives(source.issue)
    } catch (err) {
      if (isIssueNotFoundError(err)) {
        return failure(
          `review-gate severity:infra — Issue #${source.issue} does not resolve via \`gh issue view\` — cannot verify the objectives-version binding for a PR whose linked Issue is at/above the objectives cutover.`,
          `Restore Issue #${source.issue}, fix \`Closes #N\` to name a real Issue, or have a principal apply the \`vinaya/waiver:review\` label, then re-run \`vinaya check review-gate\`.`
        )
      }
      return failure(
        `review-gate severity:infra — could not fetch Issue #${source.issue}'s body via \`gh issue view\` to resolve its objectives version: ${(err as Error).message}`,
        'Confirm `gh auth status` passes and the Issue number is correct, then re-run `vinaya check review-gate`.'
      )
    }
    const parsed = objectivesOf(issueBody)
    if (!parsed.ok) {
      return failure(
        `review-gate severity:infra — Issue #${source.issue}'s \`## Objectives\` section does not parse (${parsed.errors.join('; ')}) — cannot verify the objectives-version binding.`,
        `Fix Issue #${source.issue}'s \`## Objectives\` section, or have a principal apply the \`vinaya/waiver:review\` label, then re-run \`vinaya check review-gate\`.`
      )
    }
    return { ok: true, value: objectivesVersion(parsed.objectives) }
  }

  // source.kind === 'body'
  const own = objectivesOf(pr.body)
  if (!own.ok) {
    return failure(
      `review-gate severity:infra — this PR body's own \`## Objectives\` section does not parse (${own.errors.join('; ')}) — cannot verify the objectives-version binding.`,
      "Fix the PR body's `## Objectives` section, or have a principal apply the `vinaya/waiver:review` label, then re-run `vinaya check review-gate`."
    )
  }
  return { ok: true, value: objectivesVersion(own.objectives) }
}

function shaFromLsRemote(branch: string): string | null {
  try {
    const out = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${branch}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    const sha = out.split(/\s+/)[0] ?? ''
    return sha === '' ? null : sha
  } catch {
    return null
  }
}

function shaFromGhApi(branch: string): string | null {
  try {
    const out = execFileSync('gh', ['api', `repos/{owner}/{repo}/git/ref/heads/${branch}`, '--jq', '.object.sha'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/**
 * The base commit the PR's candidate is judged against — the PR's base
 * branch (`baseRefName`) resolved to its
 * current tip via the same `git ls-remote`/forge-ref path `resolveTrueHeadSha`
 * uses for the head. `null` on a genuine resolution failure, which the
 * assembly below turns into a returned failure — never a fallback to a
 * stale or attacker-suppliable value, the same fail-safe direction the head
 * resolution takes. The base branch NAME comes from `gh pr view`'s
 * `baseRefName` (server-side PR metadata), and only its tip sha is resolved
 * here, so a PR cannot steer this at a base it does not actually target.
 */
function resolveBaseSha(pr: PrView): string | null {
  return shaFromLsRemote(pr.baseRefName) ?? shaFromGhApi(pr.baseRefName)
}

/**
 * The branch's true head — `git ls-remote`, falling back to the forge's own
 * ref API when git is unavailable. `null` on a genuine resolution failure
 * (never a fallback to `pr.headRefOid`, which can lag a push). Logs to
 * stderr, never fails on its own, when `pr.headRefOid` disagrees with the
 * resolved true head.
 */
function resolveTrueHeadSha(pr: PrView): string | null {
  const trueSha = shaFromLsRemote(pr.headRefName) ?? shaFromGhApi(pr.headRefName)
  if (trueSha && pr.headRefOid && trueSha !== pr.headRefOid) {
    process.stderr.write(
      `Warning: PR #${pr.number}'s headRefOid (${pr.headRefOid}) disagrees with the true head ${trueSha} resolved from \`${pr.headRefName}\` — using the true head.\n`
    )
  }
  return trueSha
}

type TimelineLabeledEvent = { event: string; actor?: { login: string } | null; label?: { name: string } | null }

function fetchWaiverLabelActor(prNumber: number, label: string): string | null {
  try {
    const out = execFileSync('gh', ['api', `repos/{owner}/{repo}/issues/${prNumber}/timeline`, '--paginate'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const events = JSON.parse(out) as TimelineLabeledEvent[]
    const matches = events.filter((e) => e.event === 'labeled' && e.label?.name === label)
    const last = matches[matches.length - 1]
    return last?.actor?.login ?? null
  } catch {
    return null
  }
}

/**
 * Every fact `checkReviewGate` judges PR `prNumber` on, assembled in the one
 * order the resolvers' own fail-closed guards depend on: the PR read, the
 * waiver label's actor, the true head, the base tip, the default-branch trust
 * anchor (principals and policy), then — only when the waiver is NOT
 * actor-verified — the objectives version and the frozen brief hash.
 *
 * The waiver pre-check sits in front of those last two deliberately: both fail
 * closed, and calling either unconditionally would make a `gh` hiccup able to
 * block an actor-verified waiver's own escape hatch (a security-review MAJOR
 * finding). Do not move either resolver ahead of it.
 */
export function assembleReviewGateInput(prNumber: number): ReviewGateInputAssembly {
  const pr = fetchPr(prNumber)
  if (!pr) {
    return failure(
      `review-gate severity:infra — could not fetch PR #${prNumber} via \`gh\`.`,
      'Confirm `gh auth status` passes and PR_NUMBER is correct, then re-run `vinaya check review-gate`.'
    )
  }

  const labels = pr.labels.map((l) => l.name)
  const waiverLabelActor = labels.includes(WAIVER_LABEL_REVIEW)
    ? fetchWaiverLabelActor(prNumber, WAIVER_LABEL_REVIEW)
    : null

  const headSha = resolveTrueHeadSha(pr)
  if (!headSha) {
    return failure(
      `review-gate severity:infra — could not resolve PR #${prNumber}'s true head via \`git ls-remote\` or the forge's \`git/ref/heads\` API.`,
      'Confirm the branch still exists on origin and `gh auth status` passes, then re-run `vinaya check review-gate`.'
    )
  }

  // The base branch NAME (`pr.baseRefName`) always exists for a real PR —
  // unlike `resolveBriefHash`/`resolveObjectivesVersion`'s `null`, which can
  // be a genuine "nothing to bind against" fact (no linked Issue, no frozen
  // brief posted yet), `resolveBaseSha` returning `null` here is ALWAYS a
  // resolution failure (both `git ls-remote` and the forge's ref API
  // failed), never a legitimate base-less case. Passing that failure through
  // as `baseSha: null` would make `compareManifest`'s own "nothing to bind
  // against" skip (`isBoundToBase`) silently revert the gate to base-blind
  // behavior on a transient `gh`/`git` hiccup — the same base-blind-fallback
  // bug a prior MAJOR finding already closed for `resolveObjectivesVersion`
  // (round 2 review, security MEDIUM). Fails closed the same way the head
  // resolution above does.
  const baseSha = resolveBaseSha(pr)
  if (!baseSha) {
    return failure(
      `review-gate severity:infra — could not resolve PR #${prNumber}'s base branch \`${pr.baseRefName}\`'s tip via \`git ls-remote\` or the forge's \`git/ref/heads\` API.`,
      'Confirm the base branch still exists on origin and `gh auth status` passes, then re-run `vinaya check review-gate`.'
    )
  }

  // `principals` comes from GitHub's API (default-branch, server-side state),
  // never local git / the PR's checkout / any env var. The generated authority
  // workflows likewise execute only their explicit default-branch checkout;
  // PR metadata is input data, never the source of the gate implementation or
  // its trust anchors. See `loadTrustAnchorConfig` in lib/config.ts for the
  // three failed attempts that established the config half of this boundary.
  const trustAnchorConfig = loadTrustAnchorConfig()
  const principalAllowlist = resolvePrincipalAllowlist(trustAnchorConfig)

  // Which severities block is repository policy — resolved from the SAME
  // default-branch trust-anchor read as `principals`, never from the PR's own
  // checkout, so a change cannot lower its own threshold. `resolveReviewPolicy`
  // refuses (throws) on a present-but-unknown severity value — returned here as
  // an infra-severity failure, the same shape every other unresolvable
  // trust-anchor fact in this file already uses.
  let reviewPolicy: ReturnType<typeof resolveReviewPolicy>
  try {
    reviewPolicy = resolveReviewPolicy(trustAnchorConfig)
  } catch (err) {
    return failure(
      `review-gate severity:infra — ${err instanceof Error ? err.message : String(err)}`,
      "Fix `reviewPolicy` in the default branch's `vinaya.config.json` to a known severity on each role's own scale, then re-run `vinaya check review-gate`."
    )
  }

  const waived = isWaiverLabelActorVerified({
    label: WAIVER_LABEL_REVIEW,
    labels,
    labelActor: waiverLabelActor,
    principalAllowlist
  })

  const comments = pr.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))

  const resolvedObjectivesVersion = waived ? ({ ok: true, value: null } as const) : resolveObjectivesVersion(pr)
  if (!resolvedObjectivesVersion.ok) return resolvedObjectivesVersion

  const resolvedBriefHash = waived ? ({ ok: true, value: null } as const) : resolveBriefHash(pr, principalAllowlist)
  if (!resolvedBriefHash.ok) return resolvedBriefHash

  return {
    ok: true,
    input: {
      comments,
      labels,
      waiverLabelActor,
      principalAllowlist,
      headSha,
      // A verdict judged a PATCH; the head sha is only its address. A merge
      // from `main` or a rebase that leaves the patch untouched must not void
      // a review that already read exactly those changes.
      patchIdOf: (sha: string) => patchIdAt(pr.baseRefName, sha),
      // The base identity the verdict is bound to — the PR's base branch tip,
      // resolved the same fail-safe way as the head. A base-only change under
      // an unchanged candidate invalidates; an equivalent rebase (patchIdOf
      // above proving the diff identical) still keeps.
      baseSha,
      objectivesVersion: resolvedObjectivesVersion.value,
      // The newest principal ruling ordinal on this PR — a pure count over the
      // comments already fetched above, so unlike `resolveObjectivesVersion`
      // this never fetches anything and never fails closed; it is computed
      // unconditionally, even under a waiver, since it can never itself be the
      // reason a resolution fails.
      rulingOrdinal: newestPrincipalRulingOrdinal(comments, principalAllowlist),
      policy: reviewPolicy,
      briefHash: resolvedBriefHash.value
    }
  }
}

/**
 * Whether the review gate passes against PR `prNumber`'s CURRENT state — the
 * driver's own question, answered in-process (never by shelling out to `vinaya
 * check review-gate`) through the same assembly the check itself uses.
 *
 * `false` for every unevaluable case, each narrated once to stderr: an
 * unresolvable input fact (the assembly's own failure), or a thrown evaluation.
 * The caller reads a `false` here as "not concluded", so an unevaluable gate
 * reopens a pull request rather than holding it shut on a fact nobody could
 * check — reconstruction is a recovery aid, never a merge gate, and the merge
 * gate's own copy of this evaluation is unaffected by anything decided here.
 */
export function reviewGatePassesForCurrentState(prNumber: number): boolean {
  try {
    const assembly = assembleReviewGateInput(prNumber)
    if (!assembly.ok) {
      process.stderr.write(
        `Note: PR #${prNumber}'s review gate could not be evaluated (${assembly.failure.message}) — reading the review as not concluded.\n`
      )
      return false
    }
    return checkReviewGate(assembly.input).verdict === 'pass'
  } catch (err) {
    process.stderr.write(
      `Note: PR #${prNumber}'s review gate could not be evaluated (${err instanceof Error ? err.message : String(err)}) — reading the review as not concluded.\n`
    )
    return false
  }
}
