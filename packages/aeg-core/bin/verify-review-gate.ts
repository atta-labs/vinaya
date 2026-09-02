#!/usr/bin/env bun

/**
 * verify-review-gate — required pre-merge CI check (aeg-review-gate-v1 task 1,
 * #474). Blocks a PR from merging unless a code-reviewer
 * `APPROVE` verdict AND a security-review `PASS` verdict both exist on the
 * PR, or an actor-verified `vinaya/waiver:review` label is present (the exact
 * pattern — `isWaiverLabelActorVerified`, reused not duplicated).
 *
 * No branch prefix bypasses the gate. A contributor controls the PR's head
 * branch name, so treating `plan/*` as proof of a docs-only diff was an
 * authority bypass. This is a going-forward gate, never a re-evaluation of
 * already-merged history.
 *
 * Thin CLI/I/O shim, same discipline as `verify-single-plan-pr.ts`: resolves
 * the PR's comments/labels/waiver-label-actor/head sha via `gh`, calls the
 * pure `checkReviewGate` (`@attalabs/aeg-core`), and exits non-zero with a
 * clear message on failure. No check logic lives here.
 *
 * `headRefOid` (#73) is resolved from GitHub via this same `gh pr view`
 * call, never from local git or an env var — see `checkReviewGate`'s own
 * module comment for why an env-sourced head would reopen the self-approval
 * hole a `BASE_SHA` env var already tried and was reverted for.
 *
 * Usage:
 *   PR_NUMBER=<n> bun packages/aeg-core/bin/verify-review-gate.ts
 *   PR_NUMBER=<n> BRANCH=<head-ref> bun packages/aeg-core/bin/verify-review-gate.ts
 *
 * Mechanical-check status (review-mechanical-gate-v1 task 2, #337) is
 * resolved via a separate `gh pr checks --json name,bucket` call, filtering
 * out this repo's own review-gate check-run name before handing the result
 * to `checkReviewGate` — that exclusion is repo-specific and belongs here,
 * never inside `aeg-core`'s pure logic, which ships to every adopter.
 *
 * Exit code: 0 (pass — clean verdicts, a verified waiver, or a non-task-branch
 * bypass) or 1 (fail — the unmet requirement is named in the printed message).
 */

import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { checkReviewGate, WAIVER_LABEL_REVIEW } from '../src/index'

const REPO_ROOT = join(import.meta.dirname, '../../..')
process.chdir(REPO_ROOT)

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

function fetchPr(prNumber: number): PrView {
  const out = execSync(`gh pr view ${prNumber} --json number,comments,labels,headRefOid`, { encoding: 'utf8' })
  return JSON.parse(out) as PrView
}

type CheckRun = { name: string; bucket: string }

/**
 * Every check-run `gh` reports for the PR, excluding `OWN_CHECK_RUN_NAME`.
 * `gh pr checks` exits non-zero whenever any check is failing or still
 * pending, but still prints valid JSON on stdout in that case (only the exit
 * code, not the output, reflects the checks' own state) — `execSync` throws
 * on that non-zero exit, so the thrown error's own `stdout` is read before
 * this is treated as a genuine fetch failure.
 */
function fetchMechanicalChecks(prNumber: number): CheckRun[] {
  try {
    const out = execSync(`gh pr checks ${prNumber} --json name,bucket`, { encoding: 'utf8' })
    return (JSON.parse(out) as CheckRun[]).filter((c) => c.name !== OWN_CHECK_RUN_NAME)
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout
    if (typeof stdout === 'string') {
      return (JSON.parse(stdout) as CheckRun[]).filter((c) => c.name !== OWN_CHECK_RUN_NAME)
    }
    throw err
  }
}

type TimelineLabeledEvent = { event: string; actor?: { login: string } | null; label?: { name: string } | null }

/**
 * Actor of the most recent `labeled` timeline event naming `label`, or `null`
 * when none exists. Uses the REST timeline endpoint via the `{owner}/{repo}`
 * placeholder `gh api` already resolves from the current repo context
 * (same pattern as `archive-task.ts`'s `gh api repos/{owner}/{repo}/commits/...`)
 * — no separate repo-resolution plumbing needed for a CLI invoked from a
 * repo checkout.
 */
function fetchWaiverLabelActor(prNumber: number, label: string): string | null {
  const out = execSync(`gh api repos/{owner}/{repo}/issues/${prNumber}/timeline --paginate`, { encoding: 'utf8' })
  const events = JSON.parse(out) as TimelineLabeledEvent[]
  const matches = events.filter((e) => e.event === 'labeled' && e.label?.name === label)
  const last = matches[matches.length - 1]
  return last?.actor?.login ?? null
}

export function main(prNumber: number): void {
  const pr = fetchPr(prNumber)
  const labels = pr.labels.map((l) => l.name)
  const waiverLabelActor = labels.includes(WAIVER_LABEL_REVIEW)
    ? fetchWaiverLabelActor(prNumber, WAIVER_LABEL_REVIEW)
    : null

  const mechanicalChecks = fetchMechanicalChecks(prNumber)

  const result = checkReviewGate({
    comments: pr.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
    labels,
    waiverLabelActor,
    mechanicalChecks,
    headSha: pr.headRefOid
  })

  if (result.verdict === 'fail') {
    console.error(`verify-review-gate FAILED (PR #${prNumber}): ${result.reason}`)
    process.exit(1)
  }

  console.log(`verify-review-gate PASS (PR #${prNumber}): ${result.reason}`)
  process.exit(0)
}

if (import.meta.main) {
  const prNumberStr = process.env.PR_NUMBER
  if (!prNumberStr) {
    console.error('verify-review-gate: PR_NUMBER env var not set — cannot evaluate. Failing closed.')
    process.exit(1)
  }
  main(Number(prNumberStr))
}
