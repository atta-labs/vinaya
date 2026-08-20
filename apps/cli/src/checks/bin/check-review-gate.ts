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
 * scope: full — a review verdict is a property of the PR, not the diff.
 */

import { execFileSync } from 'node:child_process'
import {
  checkReviewGate,
  isChangesetsReleasePr,
  isReviewGateExemptBranch,
  WAIVER_LABEL_REVIEW
} from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist, resolveReleaseActor } from '../../lib/config'

const CHECK_NAME = 'review-gate'

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

type PrView = {
  number: number
  comments: { body: string; author?: { login?: string } | null }[]
  labels: { name: string }[]
  headRefOid: string
  // Fetched live via `gh pr view`, never from an env var — a `pull_request`-
  // triggered workflow runs the PR's OWN copy of its YAML, so anything this
  // check read from `process.env` would just be whatever literal string the
  // PR's own workflow file chose to set, not a real fact about who opened it.
  // Same reasoning `loadTrustAnchorConfig` already applies to `principals`
  // (this file's own module comment, "three rounds of the same bug").
  author: string | null
}

function fetchPr(prNumber: number): PrView | null {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'number,comments,labels,headRefOid,author'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const raw = JSON.parse(out) as Omit<PrView, 'author'> & { author?: { login?: string } | null }
    return { ...raw, author: raw.author?.login ?? null }
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
  const branch = process.env.BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (isReviewGateExemptBranch(branch)) {
    // plan/* — no PR fetch needed for this one, same as before this change.
    process.exit(0)
  }

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

  // `principals`/`releaseActor` both come from GitHub's API (default-branch,
  // server-side state), never local git / the PR's checkout / any env var —
  // all three of those are rewritable by the PR being evaluated, since a
  // `pull_request`-triggered workflow runs the PR's own YAML. See
  // `loadTrustAnchorConfig` in lib/config.ts for the three failed attempts
  // that established this. One fetch, reused for both resolutions below.
  const trustAnchorConfig = loadTrustAnchorConfig()

  if (isChangesetsReleasePr(branch, pr.author, resolveReleaseActor(trustAnchorConfig))) {
    // pr.author came from the live `gh pr view` call above, not an env var —
    // see PrView's own field comment for why that distinction is load-bearing.
    // The expected value is adopter-configurable, never hardcoded — see
    // `isChangesetsReleasePr`'s own doc comment (security review, PR #165
    // round 4: a hardcoded expectation never matched this repo's real
    // release-PR author).
    process.exit(0)
  }

  const labels = pr.labels.map((l) => l.name)
  const waiverLabelActor = labels.includes(WAIVER_LABEL_REVIEW)
    ? fetchWaiverLabelActor(prNumber, WAIVER_LABEL_REVIEW)
    : null

  const result = checkReviewGate({
    comments: pr.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
    labels,
    waiverLabelActor,
    principalAllowlist: resolvePrincipalAllowlist(trustAnchorConfig),
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
