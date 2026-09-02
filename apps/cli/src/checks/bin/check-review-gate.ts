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
 * Mechanical-check status (#337) is
 * resolved via a separate `gh pr checks --json name,bucket` call, filtering
 * out this repo's own review-gate check-run name before handing the result
 * to `checkReviewGate` — that exclusion is repo-specific and belongs here,
 * never inside `aeg-core`'s pure logic, which ships to every adopter.
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
}

function fetchPr(prNumber: number): PrView | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'number,comments,labels,headRefOid'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return JSON.parse(out) as PrView
  } catch {
    return null
  }
}

type CheckRun = { name: string; bucket: string }

/**
 * Every check-run `gh` reports for the PR, excluding `OWN_CHECK_RUN_NAME`.
 * `null` on a genuine fetch failure — distinct from an empty result: `gh pr
 * checks` exits non-zero whenever any check is failing or still pending, but
 * still prints valid JSON on stdout in that case (only the exit code, not the
 * output, reflects the checks' own state), so a non-zero exit is read from
 * the thrown error's own `stdout` before being treated as a failure.
 */
function fetchMechanicalChecks(prNumber: number): CheckRun[] | null {
  try {
    const out = execFileSync('gh', ['pr', 'checks', String(prNumber), '--json', 'name,bucket'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return (JSON.parse(out) as CheckRun[]).filter((c) => c.name !== OWN_CHECK_RUN_NAME)
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout
    if (typeof stdout === 'string') {
      try {
        return (JSON.parse(stdout) as CheckRun[]).filter((c) => c.name !== OWN_CHECK_RUN_NAME)
      } catch {
        return null
      }
    }
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

  const mechanicalChecks = fetchMechanicalChecks(prNumber)
  if (mechanicalChecks === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate severity:infra — could not fetch check-run status for PR #${prNumber} via \`gh pr checks\`.`,
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
    headSha: pr.headRefOid
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
