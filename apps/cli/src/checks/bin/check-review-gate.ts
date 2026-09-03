#!/usr/bin/env bun

/**
 * Core check: review-gate. Thin adapter over `@attalabs/aeg-core`'s
 * `checkReviewGate` — mirrors `packages/aeg-core/bin/verify-review-gate.ts`'s
 * input assembly (PR comments/labels/waiver-label-actor/head sha via `gh`)
 * exactly, emitting the check contract instead of human text.
 *
 * `headRefOid` (#73) is resolved from this same `gh pr view` call, never
 * from local git or an env var — see `checkReviewGate`'s own module comment
 * for why an env-sourced head would reopen the self-approval hole a
 * `BASE_SHA` env var already tried and was reverted for (registry.ts's own
 * comment on this check's entry states the same prohibition).
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
import { checkReviewGate, WAIVER_LABEL_REVIEW } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../../lib/config'

const CHECK_NAME = 'review-gate'

// This repo's own review-gate check-run name (`.github/workflows/vinaya-review.yml:51`).
// `vinaya-review-verdict.yml`'s retrigger job re-runs that same workflow run
// rather than opening a new one (GitHub's 2025-02-12 check-run-ownership
// restriction), so verdict re-evaluation reports under this identical name
// too — there is only ever one review-gate check-run name to exclude. The
// exclusion lives HERE, never inside `checkReviewGate` itself: `aeg-core`
// ships to every adopter, and an adopter's workflow will not be named this.
const OWN_CHECK_RUN_NAME = 'vinaya review gate'

type PrView = {
  number: number
  comments: { body: string; author?: { login?: string } | null }[]
  labels: { name: string }[]
  headRefOid: string
  baseRefName: string
}

function fetchPr(prNumber: number): PrView | null {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'number,comments,labels,headRefOid,baseRefName'],
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

/**
 * This PR's patch identity at `sha`: `git diff origin/<base>...<sha> | git
 * patch-id --stable`. `--stable` is what makes the value comparable across
 * two different commits carrying the same changes — the unstable default
 * folds in context that a rebase or a merge from the base perturbs.
 *
 * The commit is FETCHED first: after a push, the judged head is no longer
 * anything local git has, and diffing against a missing object throws. A
 * throw anywhere here returns `null`, which `checkReviewGate` reads as
 * "cannot answer" and never as "they match" — so a genuinely unreachable
 * judged head (a force-push that discarded it) correctly stops counting
 * rather than silently passing.
 */
function patchIdAt(base: string, sha: string): string | null {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', sha], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    // Non-fatal on its own: the object may already be local. The diff below
    // is the real test of whether it is reachable.
  }
  try {
    const diff = execFileSync('git', ['diff', `origin/${base}...${sha}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (diff === '') return null
    const out = execFileSync('git', ['patch-id', '--stable'], {
      input: diff,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    const id = out.split(/\s+/)[0] ?? ''
    return id === '' ? null : id
  } catch {
    return null
  }
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

  const mechanicalChecks = fetchMechanicalChecks(pr.headRefOid)
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
  const result = checkReviewGate({
    comments: pr.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
    labels,
    waiverLabelActor,
    principalAllowlist: resolvePrincipalAllowlist(loadTrustAnchorConfig()),
    mechanicalChecks,
    headSha: pr.headRefOid,
    // A verdict judged a PATCH; the head sha is only its address. A merge
    // from `main` or a rebase that leaves the patch untouched must not void
    // a review that already read exactly those changes.
    patchIdOf: (sha: string) => patchIdAt(pr.baseRefName, sha)
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

main()
