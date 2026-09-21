#!/usr/bin/env bun

/**
 * Core check: review-gate. Thin adapter over `@attalabs/aeg-core`'s
 * `checkReviewGate` — mirrors `packages/aeg-core/bin/verify-review-gate.ts`'s
 * input assembly (PR comments/labels/waiver-label-actor/head sha via `gh`)
 * exactly, emitting the check contract instead of human text.
 *
 * The head sha is the branch's TRUE head: `gh pr view`
 * resolves only the branch NAME (`headRefName`), and the sha itself comes
 * from `git ls-remote origin refs/heads/<branch>` (this gate runs in CI
 * with a checkout, so `git` is available) — never from a caller-suppliable
 * env var, and never from `gh pr view`'s own `headRefOid` field, which can
 * lag a push (confirmed live: after a push, `gh pr view` still reported the prior
 * sha). `headRefOid` is read only as a cross-check, logged when it
 * disagrees — see `checkReviewGate`'s own module comment for why an
 * env-sourced head would reopen the self-approval hole a `BASE_SHA` env var
 * already tried and was reverted for (registry.ts's own comment on this
 * check's entry states the same prohibition; `git ls-remote` queries the
 * remote live and is not that env var).
 *
 * Second documented divergence: this
 * adapter resolves a real `objectivesVersion` (Issue-then-body, fail-closed
 * on every unresolvable case) via `resolveObjectivesVersion` below.
 * `verify-review-gate.ts` does not — it always passes `objectivesVersion:
 * null`, unconditionally skipping the objectives-version half of the
 * binding, because it has no equivalent Issue-body-fetch machinery and is
 * not this repo's live review-gate path (see the divergence above). Any doc
 * describing which file resolves the objectives-version binding must name
 * THIS file, not the reference script.
 *
 * Documented divergence from the reference script: `verify-review-gate.ts`
 * fails CLOSED when `PR_NUMBER` is unset, because its only real caller
 * (`forge-lifecycle.yml`) is triggered exclusively on an existing PR. This
 * adapter is also reachable from a pre-push hook / local `vinaya check
 * --all` run BEFORE a PR exists — failing closed there would block every
 * push on a brand-new branch. No `PR_NUMBER` here instead bypasses (exit
 * 0), the same "nothing to evaluate yet" shape `brief-shape`/`test-plan`
 * already use for a missing `PR_BODY`.
 *
 * Reviews only. This adapter resolves no other check's result and reads no
 * Test Plan tick-state: every merge condition is its own independent check,
 * so that all green means mergeable, and a gate that re-reported a sibling
 * check's red answered a question it does not own. The principal Test Plan
 * wait is a check of its own; a red sibling check is already red on its own
 * name.
 *
 * scope: full — a review verdict is a property of the PR, not the diff.
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
  WAIVER_LABEL_REVIEW
} from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist, resolveReviewPolicy } from '../../lib/config'
import { patchIdAt } from '../../lib/patch-id'

const CHECK_NAME = 'review-gate'

type PrView = {
  number: number
  comments: { body: string; author?: { login?: string } | null }[]
  labels: { name: string }[]
  headRefName: string
  headRefOid: string
  baseRefName: string
  body: string
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

/**
 * The frozen brief's own hash this PR is judged against — `null` in
 * exactly TWO cases: the PR closes no Issue (`extractIssue`,
 * resolved before any fetch), or that Issue's real, successfully-fetched
 * comment list carries no principal-authored frozen brief yet
 * (`resolveNewestFrozenBrief` returning `null` on genuine data, not on an
 * error). Every OTHER case — the fetch itself throwing (network error, `gh`
 * auth failure, malformed JSON) — fails this check outright
 * (`severity:infra`, exit `1`), the identical fail-closed treatment
 * `resolveObjectivesVersion` already gives its own fetch failure, and for
 * the identical reason (a round-3 review finding): the prior version caught
 * every exception into `null`, and `isBoundToBriefHash` treats a `null`
 * current hash as "skip the binding" — collapsing "the fetch failed" and
 * "no brief was ever posted" into the same permissive skip let a transient
 * `gh` hiccup at merge time silently disarm the whole brief-hash freshness
 * check, passing a PR whose frozen brief was actually superseded. Callers
 * must guard this the same way `resolveObjectivesVersion` is guarded: never
 * invoke it when `waived` is `true`, so the waiver's own escape hatch stays
 * reachable even though this now fails closed (a MAJOR finding,
 * reapplied here).
 */
function resolveBriefHash(pr: PrView, principalAllowlist: readonly string[]): string | null {
  const { issue } = extractIssue(pr.body)
  if (issue === null) return null
  let comments: { body: string; author: string | null }[]
  try {
    comments = fetchIssueCommentsForBrief(issue)
  } catch (err) {
    if (isIssueNotFoundError(err)) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message: `review-gate severity:infra — Issue #${issue} does not resolve via \`gh issue view\` — cannot verify the brief-hash binding for a PR whose linked Issue no longer exists.`,
        agent_recovery_prompt: `Restore Issue #${issue}, fix \`Closes #N\` to name a real Issue, or have a principal apply the \`vinaya/waiver:review\` label, then re-run \`vinaya check review-gate\`.`
      })
      process.exit(1)
    }
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate severity:infra — could not fetch Issue #${issue}'s comments via \`gh issue view\` to resolve its frozen-brief hash: ${(err as Error).message}`,
      agent_recovery_prompt:
        'Confirm `gh auth status` passes and the Issue number is correct, then re-run `vinaya check review-gate`.'
    })
    process.exit(1)
  }
  const frozen = resolveNewestFrozenBrief(comments, principalAllowlist as string[])
  return frozen ? briefHash(frozen.content) : null
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
 * (Issue's or body's) — fails this check outright (`severity:infra`, exit
 * `1`). A security review on this task found the prior version
 * returning a silent `null` for the first two of those: falling through to
 * the body's own section (or straight to `null`) whenever the linked Issue
 * came back "not found", and swallowing a parse failure into `null` in both
 * the Issue and body branches. Since `isBoundToObjectives` treats a `null`
 * current version as an unconditional match, that silent `null` let anyone
 * who can edit or delete the LINKED ISSUE (not necessarily anyone with PR
 * push access) disarm the objectives-version binding for an
 * already-cast verdict after the fact — exactly the staleness this task
 * exists to catch. `vinaya review post`'s `resolveObjectivesForPr` already
 * refuses to POST a new verdict in every one of these identical cases
 * (`no objectives to judge against`); this resolver now refuses to COUNT an
 * existing one clean for the same cases, closing the gap rather than
 * mirroring it. The two resolvers' Issue-vs-cutover branch order is now
 * identical too — the prior version's missing early pre-cutover return let
 * it fall through to the body's own section for a pre-cutover Issue, which
 * could resolve a non-null version `review post` never rendered a matching
 * line for, permanently failing the gate on an otherwise-legitimate PR (the
 * same review's MEDIUM finding).
 *
 * This function's own `process.exit(1)` calls run BEFORE `checkReviewGate`
 * — the call site passes its return value as an inline argument expression,
 * so it is evaluated first. `main()` never calls this function at all when
 * an actor-verified `vinaya/waiver:review` label is present, precisely so
 * that fail-closed path cannot make the waiver's own escape hatch
 * unreachable (a security-review MAJOR finding). Do not inline a call to this
 * function directly into `checkReviewGate({...})` again without keeping
 * that waiver pre-check in front of it.
 */
function resolveObjectivesVersion(pr: PrView): string | null {
  const { issue } = extractIssue(pr.body)
  const source = resolveObjectivesSource(pr.body, issue, OBJECTIVES_SINCE_ISSUE)

  if (source.kind === 'none') return null

  if (source.kind === 'issue') {
    let issueBody: string
    try {
      issueBody = fetchIssueBodyForObjectives(source.issue)
    } catch (err) {
      if (isIssueNotFoundError(err)) {
        emitCheckError({
          schema: CHECK_SCHEMA_VERSION,
          check: CHECK_NAME,
          severity: 'error',
          message: `review-gate severity:infra — Issue #${source.issue} does not resolve via \`gh issue view\` — cannot verify the objectives-version binding for a PR whose linked Issue is at/above the objectives cutover.`,
          agent_recovery_prompt: `Restore Issue #${source.issue}, fix \`Closes #N\` to name a real Issue, or have a principal apply the \`vinaya/waiver:review\` label, then re-run \`vinaya check review-gate\`.`
        })
        process.exit(1)
      }
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message: `review-gate severity:infra — could not fetch Issue #${source.issue}'s body via \`gh issue view\` to resolve its objectives version: ${(err as Error).message}`,
        agent_recovery_prompt:
          'Confirm `gh auth status` passes and the Issue number is correct, then re-run `vinaya check review-gate`.'
      })
      process.exit(1)
    }
    const parsed = objectivesOf(issueBody)
    if (!parsed.ok) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message: `review-gate severity:infra — Issue #${source.issue}'s \`## Objectives\` section does not parse (${parsed.errors.join('; ')}) — cannot verify the objectives-version binding.`,
        agent_recovery_prompt: `Fix Issue #${source.issue}'s \`## Objectives\` section, or have a principal apply the \`vinaya/waiver:review\` label, then re-run \`vinaya check review-gate\`.`
      })
      process.exit(1)
    }
    return objectivesVersion(parsed.objectives)
  }

  // source.kind === 'body'
  const own = objectivesOf(pr.body)
  if (!own.ok) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate severity:infra — this PR body's own \`## Objectives\` section does not parse (${own.errors.join('; ')}) — cannot verify the objectives-version binding.`,
      agent_recovery_prompt:
        "Fix the PR body's `## Objectives` section, or have a principal apply the `vinaya/waiver:review` label, then re-run `vinaya check review-gate`."
    })
    process.exit(1)
  }
  return objectivesVersion(own.objectives)
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
 * The branch's true head — `git ls-remote`, falling back to the forge's own
 * ref API when git is unavailable. `null` on a genuine resolution failure
 * (never a fallback to `pr.headRefOid`, which can lag a push). Logs to
 * stderr, never fails the check on its own, when `pr.headRefOid` disagrees
 * with the resolved true head.
 */
/**
 * The base commit the PR's candidate is judged against — the PR's base
 * branch (`baseRefName`) resolved to its
 * current tip via the same `git ls-remote`/forge-ref path `resolveTrueHeadSha`
 * uses for the head. `null` on a genuine resolution failure, which
 * `checkReviewGate` reads as "skip the base binding" — never a fallback to a
 * stale or attacker-suppliable value, the same fail-safe direction the head
 * resolution above takes. The base branch NAME comes from `gh pr view`'s
 * `baseRefName` (server-side PR metadata), and only its tip sha is resolved
 * here, so a PR cannot steer this at a base it does not actually target.
 */
function resolveBaseSha(pr: PrView): string | null {
  return shaFromLsRemote(pr.baseRefName) ?? shaFromGhApi(pr.baseRefName)
}

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

function main(): void {
  const prNumberStr = process.env.PR_NUMBER
  if (!prNumberStr) {
    // No PR to evaluate yet (local dev, pre-push before a PR exists).
    process.exit(0)
  }

  const prNumber = Number(prNumberStr)
  const pr = fetchPr(prNumber)
  if (!pr) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate severity:infra — could not fetch PR #${prNumber} via \`gh\`.`,
      agent_recovery_prompt:
        'Confirm `gh auth status` passes and PR_NUMBER is correct, then re-run `vinaya check review-gate`.'
    })
    process.exit(1)
  }

  const labels = pr.labels.map((l) => l.name)
  const waiverLabelActor = labels.includes(WAIVER_LABEL_REVIEW)
    ? fetchWaiverLabelActor(prNumber, WAIVER_LABEL_REVIEW)
    : null

  const headSha = resolveTrueHeadSha(pr)
  if (!headSha) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate severity:infra — could not resolve PR #${prNumber}'s true head via \`git ls-remote\` or the forge's \`git/ref/heads\` API.`,
      agent_recovery_prompt:
        'Confirm the branch still exists on origin and `gh auth status` passes, then re-run `vinaya check review-gate`.'
    })
    process.exit(1)
  }

  // The base branch NAME (`pr.baseRefName`) always exists for a real PR —
  // unlike `resolveBriefHash`/`resolveObjectivesVersion`'s `null`, which can
  // be a genuine "nothing to bind against" fact (no linked Issue, no frozen
  // brief posted yet), `resolveBaseSha` returning `null` here is ALWAYS a
  // resolution failure (both `git ls-remote` and the forge's ref API
  // failed), never a legitimate base-less case. Passing that failure through
  // as `baseSha: null` would make `compareManifest`'s own "nothing to bind
  // against" skip (`isBoundToBase`) silently revert this check to its
  // pre-task, base-blind behavior on a transient `gh`/`git` hiccup — the
  // same base-blind-fallback bug a prior MAJOR finding already closed for
  // `resolveObjectivesVersion`, reapplied here (round 2 review, security
  // MEDIUM). Fails closed the same way `resolveTrueHeadSha`'s own `null`
  // does, above.
  const baseSha = resolveBaseSha(pr)
  if (!baseSha) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate severity:infra — could not resolve PR #${prNumber}'s base branch \`${pr.baseRefName}\`'s tip via \`git ls-remote\` or the forge's \`git/ref/heads\` API.`,
      agent_recovery_prompt:
        'Confirm the base branch still exists on origin and `gh auth status` passes, then re-run `vinaya check review-gate`.'
    })
    process.exit(1)
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
  // default-branch trust-anchor read
  // as `principals`, never from the PR's own checkout, so a change cannot
  // lower its own threshold. `resolveReviewPolicy` refuses (throws) on a
  // present-but-unknown severity value — caught here and reported as an
  // infra-severity check error, the same shape every other unresolvable
  // trust-anchor fact in this file already uses.
  let reviewPolicy: ReturnType<typeof resolveReviewPolicy>
  try {
    reviewPolicy = resolveReviewPolicy(trustAnchorConfig)
  } catch (err) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate severity:infra — ${err instanceof Error ? err.message : String(err)}`,
      agent_recovery_prompt:
        "Fix `reviewPolicy` in the default branch's `vinaya.config.json` to a known severity on each role's own scale, then re-run `vinaya check review-gate`."
    })
    process.exit(1)
  }

  // A verified waiver skips objectives resolution entirely (a security-review
  // MAJOR finding) — `resolveObjectivesVersion` fails closed (`process.exit(1)`)
  // on an unresolvable Issue, which runs BEFORE `checkReviewGate` is ever
  // called (it is an inline argument expression) and would make `checkReviewGate`'s
  // own waiver short-circuit unreachable for exactly the case the waiver
  // exists to rescue: a linked Issue that got deleted or renumbered. Checking
  // the waiver here first, with the identical `isWaiverLabelActorVerified`
  // predicate `checkReviewGate` uses internally, restores that escape hatch
  // without weakening it — an unverified/missing label still falls through
  // to the real resolution and its fail-closed behavior, unchanged.
  const waived = isWaiverLabelActorVerified({
    label: WAIVER_LABEL_REVIEW,
    labels,
    labelActor: waiverLabelActor,
    principalAllowlist
  })

  const result = checkReviewGate({
    comments: pr.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
    labels,
    waiverLabelActor,
    principalAllowlist,
    headSha,
    // A verdict judged a PATCH; the head sha is only its address. A merge
    // from `main` or a rebase that leaves the patch untouched must not void
    // a review that already read exactly those changes.
    patchIdOf: (sha: string) => patchIdAt(pr.baseRefName, sha),
    // The base identity the verdict is bound to — the PR's base branch tip,
    // resolved the same fail-safe way as the head. A
    // base-only change under an unchanged candidate now invalidates; an
    // equivalent rebase (patchIdOf above proving the diff identical) still
    // keeps, unchanged.
    baseSha,
    objectivesVersion: waived ? null : resolveObjectivesVersion(pr),
    // The newest principal ruling ordinal on this PR —
    // a pure count over `pr.comments`, already fetched
    // above, so unlike `resolveObjectivesVersion` this never fetches
    // anything and never fails closed; it is computed unconditionally, even
    // under a waiver, since it can never itself be the reason a resolution
    // fails.
    rulingOrdinal: newestPrincipalRulingOrdinal(
      pr.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
      principalAllowlist
    ),
    policy: reviewPolicy,
    // The frozen brief's own hash at evaluation time —
    // never fetched under a waiver, the identical `objectivesVersion`
    // treatment above and for the identical reason (a round-3 review
    // finding): `resolveBriefHash` now fails closed on a genuine fetch
    // error, so calling it unconditionally would make a `gh` hiccup able to
    // block an actor-verified waiver's own escape hatch — the exact bug
    // a MAJOR finding closed for `resolveObjectivesVersion`.
    briefHash: waived ? null : resolveBriefHash(pr, principalAllowlist)
  })

  if (result.verdict === 'fail') {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate (PR #${prNumber}): ${result.reason}`,
      agent_recovery_prompt:
        'Wait for a code-reviewer APPROVE and a security-review PASS on this PR (or ask a principal to apply the `vinaya/waiver:review` label), then re-run `vinaya check review-gate`.'
    })
    process.exit(1)
  }

  process.exit(0)
}

// Guarded so this module can be imported by unit tests without executing the
// check. Spawned as a bin (the only way it runs for real) this is still true.
if (import.meta.main) {
  main()
}
