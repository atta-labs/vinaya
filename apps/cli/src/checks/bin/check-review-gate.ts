#!/usr/bin/env bun

/**
 * Core check: review-gate. Thin adapter over `@attalabs/aeg-core`'s
 * `checkReviewGate` — mirrors `packages/aeg-core/bin/verify-review-gate.ts`'s
 * input assembly (PR comments/labels/waiver-label-actor/head sha via `gh`)
 * exactly, emitting the check contract instead of human text.
 *
 * The head sha (#73, `#402` O1) is the branch's TRUE head: `gh pr view`
 * resolves only the branch NAME (`headRefName`), and the sha itself comes
 * from `git ls-remote origin refs/heads/<branch>` (this gate runs in CI
 * with a checkout, so `git` is available) — never from a caller-suppliable
 * env var, and never from `gh pr view`'s own `headRefOid` field, which can
 * lag a push (`#371`: after a push, `gh pr view` still reported the prior
 * sha). `headRefOid` is read only as a cross-check, logged when it
 * disagrees — see `checkReviewGate`'s own module comment for why an
 * env-sourced head would reopen the self-approval hole a `BASE_SHA` env var
 * already tried and was reverted for (registry.ts's own comment on this
 * check's entry states the same prohibition; `git ls-remote` queries the
 * remote live and is not that env var).
 *
 * Second documented divergence (`#412`, O3, `#433` security review): this
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
 * Mechanical-check status (#337) is resolved via the REST "list check-runs
 * for a ref" endpoint (`gh api repos/{owner}/{repo}/commits/{sha}/check-runs`),
 * filtering out this repo's own review-gate check-run name before handing
 * the result to `checkReviewGate` — that exclusion is repo-specific and
 * belongs here, never inside `aeg-core`'s pure logic, which ships to every
 * adopter.
 *
 * NOT `gh pr checks --json name,bucket` (#341's original shape, #345):
 * that command's GraphQL query asks for `checkSuite.workflowRun` on every
 * check context, and the ephemeral `GITHUB_TOKEN` a workflow run receives
 * is structurally forbidden from resolving `workflowRun` for a check suite
 * belonging to a DIFFERENT workflow run than the one currently executing —
 * "Resource not accessible by integration", unconditionally, no `permissions:`
 * scope fixes it (confirmed live: `checks: read` granted, GraphQL query still
 * refused; the REST endpoint below, which never touches `workflowRun`,
 * succeeded with the identical token in the same job). A personal PAT has no
 * such restriction, which is why every local repro of this check always
 * passed and masked the bug through #341's original review and #346's first
 * (incomplete) fix pass.
 *
 * scope: full — a review verdict is a property of the PR, not the diff.
 */

import { execFileSync } from 'node:child_process'
import {
  checkReviewGate,
  evaluateTestPlanGate,
  extractIssue,
  isIssueNotFoundError,
  isWaiverLabelActorVerified,
  newestPrincipalRulingOrdinal,
  OBJECTIVES_SINCE_ISSUE,
  objectivesOf,
  objectivesVersion,
  resolveObjectivesSource,
  WAIVER_LABEL_REVIEW
} from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist, resolveReviewPolicy } from '../../lib/config'
import { patchIdAt } from '../../lib/patch-id'
import { REVIEW_GATE_CHECK_RUN_NAME as OWN_CHECK_RUN_NAME } from '../../lib/review-gate-check-name'

const CHECK_NAME = 'review-gate'

// This repo's own review-gate check-run name (`.github/workflows/vinaya-review.yml:51`).
// `vinaya-review-verdict.yml`'s retrigger job re-runs that same workflow run
// rather than opening a new one (GitHub's 2025-02-12 check-run-ownership
// restriction), so verdict re-evaluation reports under this identical name
// too — there is only ever one review-gate check-run name to exclude. The
// exclusion lives HERE, never inside `checkReviewGate` itself: `aeg-core`
// ships to every adopter, and an adopter's workflow will not be named this.
// Promoted to `../../lib/review-gate-check-name` (`#488`, O1) so
// `dev-review-loop.ts`'s mechanical gate reads the identical constant
// rather than a second hardcoded copy.

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

/**
 * The current `objectivesVersion` this PR is judged against (`#412`, O3).
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
 * `1`). A security review on this task (`#433`) found the prior version
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
 * unreachable (`#433`, security review MAJOR). Do not inline a call to this
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

/**
 * The `[principal]` half of `test-plan`'s own tick-state gate, moved HERE —
 * enforcement of an unticked `[principal]` Test Plan item does not disappear
 * when `test-plan`'s registry entry is marked `principalOwed`, it moves to
 * where a MERGE is actually refused: this check. `test-plan` keeps grading the `[agent]` half and the plan's
 * structure only; ticking a `[principal]` box is what a Principal does after
 * verifying in a real signed-in browser, and this is the check that refuses
 * a merge while one is still unticked, in the same `review-gate (PR #N): …`
 * message shape `checkReviewGate`'s own missing-verdict fail already uses.
 *
 * Reuses `evaluateTestPlanGate` — the exact same tick-detection logic
 * `check-test-plan.ts` runs — rather than re-implementing the checkbox scan,
 * so the two checks can never disagree about which lines are unticked.
 * Returns `null` when there is nothing to refuse: `verdict === 'pass'` (no
 * section, sentinel, no `[principal]` items, or all ticked) or a fail whose
 * cause is the OTHER (structural, no-section) branch — that one is
 * `test-plan`'s to grade and block on, not this check's; see
 * `check-test-plan.ts`'s own cause classification, which this mirrors.
 */
export function uncheckedPrincipalReason(body: string, branch: string): string | null {
  const result = evaluateTestPlanGate(body, branch)
  if (result.verdict !== 'fail') return null
  const uncheckedLines = result.messages.filter((m) => /^\s*[-*]\s+\[\s\]/.test(m)).map((m) => m.trim())
  if (uncheckedLines.length === 0) return null
  return `unticked [principal] Test Plan item(s) — ${uncheckedLines.join('; ')}`
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
function resolveTrueHeadSha(pr: PrView): string | null {
  const trueSha = shaFromLsRemote(pr.headRefName) ?? shaFromGhApi(pr.headRefName)
  if (trueSha && pr.headRefOid && trueSha !== pr.headRefOid) {
    process.stderr.write(
      `Warning: PR #${pr.number}'s headRefOid (${pr.headRefOid}) disagrees with the true head ${trueSha} resolved from \`${pr.headRefName}\` — using the true head.\n`
    )
  }
  return trueSha
}

type CheckRun = { name: string; bucket: string }

type RestCheckRun = { id: number; name: string; status: string; conclusion: string | null }

/**
 * Mirrors `gh pr checks --json name,bucket`'s `bucket` vocabulary
 * ("pass" | "fail" | "pending" | "skipping" | "cancel") from the REST
 * check-run shape, since `checkReviewGate` (aeg-core) reads `bucket`, not
 * raw `status`/`conclusion`. Only the `=== 'pass'` distinction is load-bearing
 * downstream — the rest exists for the human-readable failure listing.
 */
function bucketFor(run: RestCheckRun): string {
  if (run.status !== 'completed') return 'pending'
  switch (run.conclusion) {
    case 'success':
      return 'pass'
    case 'neutral':
    case 'skipped':
      return 'skipping'
    case 'cancelled':
      return 'cancel'
    default:
      return 'fail'
  }
}

/**
 * Every check-run GitHub reports for `headSha`, excluding `OWN_CHECK_RUN_NAME`,
 * deduped to the LATEST run per name. `null` on a genuine fetch failure.
 * Paginated: a PR can carry more check-runs than one page returns.
 *
 * A re-triggered check (a label toggle, a re-run, a pushed fixup) leaves its
 * earlier attempts in this endpoint's response too — it is a full history,
 * not "current state" the way the PR's own Checks tab or `gh pr checks`
 * renders it. Without the dedup below, one stale failed/cancelled attempt
 * under a name that has since gone green permanently poisons the verdict,
 * even though the PR's UI shows every check green (confirmed live: PR #343
 * carried both a failed and a passing `vinaya check body-bare-digits` run
 * for the same head, from before and after a mid-flight fix). Check-run ids
 * are monotonically increasing, so the highest id per name is the latest.
 */
function fetchMechanicalChecks(headSha: string): CheckRun[] | null {
  try {
    const out = execFileSync(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
        '--paginate',
        '--jq',
        '.check_runs[] | {id, name, status, conclusion}'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    // `--jq` streams one check-run object per line (newline-delimited JSON);
    // `--paginate` re-applies that filter per page, so this stays one object
    // per line across the whole PR, however many pages it takes.
    const runs: RestCheckRun[] = out
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RestCheckRun)

    const latestByName = new Map<string, RestCheckRun>()
    for (const run of runs) {
      const seen = latestByName.get(run.name)
      if (!seen || run.id > seen.id) latestByName.set(run.name, run)
    }

    return Array.from(latestByName.values())
      .filter((r) => r.name !== OWN_CHECK_RUN_NAME)
      .map((r) => ({ name: r.name, bucket: bucketFor(r) }))
  } catch {
    return null
  }
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

  const mechanicalChecks = fetchMechanicalChecks(headSha)
  if (mechanicalChecks === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate severity:infra — could not fetch check-run status for PR #${prNumber} via the REST check-runs endpoint.`,
      agent_recovery_prompt:
        'Confirm `gh auth status` passes and PR_NUMBER is correct, then re-run `vinaya check review-gate`.'
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

  // Which severities block is repository policy (task
  // 8, `#506`, O4) — resolved from the SAME default-branch trust-anchor read
  // as `principals`, never from the PR's own checkout, so a change cannot
  // lower its own threshold. `resolveReviewPolicy` refuses (throws) on a
  // present-but-unknown severity value (O1) — caught here and reported as an
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

  // A verified waiver skips objectives resolution entirely (#433, security
  // review MAJOR) — `resolveObjectivesVersion` fails closed (`process.exit(1)`)
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
    mechanicalChecks,
    headSha,
    // A verdict judged a PATCH; the head sha is only its address. A merge
    // from `main` or a rebase that leaves the patch untouched must not void
    // a review that already read exactly those changes.
    patchIdOf: (sha: string) => patchIdAt(pr.baseRefName, sha),
    objectivesVersion: waived ? null : resolveObjectivesVersion(pr),
    // The newest principal ruling ordinal on this PR (task 3, #477, O2) —
    // a pure count over `pr.comments`, already fetched
    // above, so unlike `resolveObjectivesVersion` this never fetches
    // anything and never fails closed; it is computed unconditionally, even
    // under a waiver, since it can never itself be the reason a resolution
    // fails.
    rulingOrdinal: newestPrincipalRulingOrdinal(
      pr.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
      principalAllowlist
    ),
    policy: reviewPolicy
  })

  let failed = false

  if (result.verdict === 'fail') {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate (PR #${prNumber}): ${result.reason}`,
      agent_recovery_prompt:
        'Wait for a code-reviewer APPROVE and a security-review PASS on this PR (or ask a principal to apply the `vinaya/waiver:review` label), then re-run `vinaya check review-gate`.'
    })
    failed = true
  }

  // O2: the `[principal]` half of `test-plan`'s tick-state gate, enforced
  // HERE — see `uncheckedPrincipalReason`'s doc comment. Independent of the
  // review verdict above (and of `vinaya/waiver:review`, which waives the
  // code-review/security obligation, never the Principal's own runtime
  // verification) — `roles/developer.md`'s Pre-merge gate already lists
  // "reviewer approved" and "Principal confirmation" as two separate items.
  const principalReason = uncheckedPrincipalReason(pr.body, pr.headRefName)
  if (principalReason !== null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate (PR #${prNumber}): ${principalReason}`,
      agent_recovery_prompt:
        'Nothing for the Developer to fix here — wait for the Principal to verify in a real signed-in browser and tick each `[principal]` Test Plan box, then re-run `vinaya check review-gate`.'
    })
    failed = true
  }

  process.exit(failed ? 1 : 0)
}

// Guarded so this module can be imported by unit tests without executing the
// check. Spawned as a bin (the only way it runs for real) this is still true.
if (import.meta.main) {
  main()
}
