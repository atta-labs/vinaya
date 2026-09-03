#!/usr/bin/env bun

/**
 * Core check: pr-body-frozen (task 5, #378). Thin adapter over
 * `@attalabs/aeg-core`'s `checkPrBodyFrozen` — mirrors `check-review-gate.ts`'s
 * comment fetch and principal-allowlist filter, since the marker comment
 * this check trusts must come from the same trust anchor a review verdict
 * does (a non-allowlisted marker is ignored, not just a non-allowlisted
 * verdict).
 *
 * Uses the body it fetched, never `PR_BODY` — this check's whole job is
 * comparing the LIVE forge body against a hash of what was posted at open,
 * so a caller-supplied `PR_BODY` (possibly stale, possibly a draft) is never
 * a substitute for the real thing. `PR_NUMBER` is the only env input this
 * bin reads for the body/comments/PR-number triple — `PR_NUMBER` itself
 * doubles as the grandfather cutoff input, so no extra `gh` field is needed
 * for it. Each comment's own `createdAt` (returned by `gh` without an extra
 * field request) feeds `findMarker`'s earliest-wins selection.
 *
 * Grandfathering is by PR NUMBER (`FROZEN_BODY_SINCE_PR`,
 * `pr-body-frozen.ts`), not by marker absence: a PR numbered below the
 * cutoff with no marker comment gets `info`; a PR numbered at or above it
 * gets `fail` — deleting the marker comment (an ordinary PR comment) no
 * longer degrades a real, post-rollout PR back into the grandfathered case.
 * An empty PR body is not a bypass either: it goes through
 * `checkPrBodyFrozen` like any other body, which grandfathers or fails it
 * by the same PR-number rule.
 *
 * requiresOpenPr: true — meaningless before a PR exists (there is no
 * marker comment to read), same reasoning as `closes-n`/`evidence-fresh`.
 * scope: diff — a property of this PR's own body and its own marker.
 *
 * `recoveryPromptFor` (failure-reason → advice) lives in the sibling
 * `../pr-body-frozen-recovery-logic.ts` rather than here, so
 * `pr-body-frozen-recovery-prompt-coverage.test.ts` can import it without
 * also running this file's unconditional `main()` — see that module's own
 * doc comment for the #355 coupling this exists to close.
 */

import { execFileSync } from 'node:child_process'
import { checkPrBodyFrozen, type PrBodyFrozenComment } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../../lib/config'
import { recoveryPromptFor } from '../pr-body-frozen-recovery-logic'

const CHECK_NAME = 'pr-body-frozen'

type Fetched = { body: string; comments: PrBodyFrozenComment[] }

function fetchPr(prNumber: number): Fetched | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'body,comments'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const parsed = JSON.parse(out) as {
      body: string
      comments: { body: string; author?: { login?: string } | null; createdAt: string }[]
    }
    return {
      body: parsed.body,
      comments: parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null, createdAt: c.createdAt }))
    }
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

  const fetched = fetchPr(prNumber)
  if (fetched === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `pr-body-frozen severity:infra — could not fetch PR #${prNumber}'s body/comments via \`gh\`.`,
      agent_recovery_prompt:
        'Confirm `gh auth status` passes and PR_NUMBER is correct, then re-run `vinaya check pr-body-frozen`.'
    })
    process.exit(1)
  }

  // Same trust anchor `checkReviewGate` uses — the repo's own `principals`
  // field on the default branch, never the PR's checkout.
  const principalAllowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())

  const result = checkPrBodyFrozen({
    body: fetched.body,
    comments: fetched.comments,
    principalAllowlist,
    prNumber
  })

  if (result.status === 'fail') {
    const agent_recovery_prompt = recoveryPromptFor(result.reason)
    for (const message of result.errors) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        agent_recovery_prompt
      })
    }
    process.exit(1)
  }

  if (result.status === 'info') {
    process.stdout.write(`${result.errors.join('\n')}\n`)
  }

  process.exit(0)
}

main()
