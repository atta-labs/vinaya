#!/usr/bin/env bun

/**
 * Core check: pr-body-frozen (task 5, #378). Thin adapter over
 * `@attalabs/aeg-core`'s `checkPrBodyFrozen` — mirrors `check-review-gate.ts`'s
 * comment fetch and principal-allowlist filter, since the marker comment
 * this check trusts must come from the same trust anchor a review verdict
 * does (a non-allowlisted marker is ignored, not just a non-allowlisted
 * verdict).
 *
 * Grandfathering: `checkPrBodyFrozen` returns `info`, never `fail`, when no
 * marker comment from an allowlisted author exists — every PR open before
 * `pr create` started posting one. `info` prints to stdout and exits 0,
 * same shape `evidence-fresh` uses for "anchor not adopted."
 *
 * requiresOpenPr: true — meaningless before a PR exists (there is no
 * marker comment to read), same reasoning as `closes-n`/`evidence-fresh`.
 * scope: diff — a property of this PR's own body and its own marker.
 */

import { execFileSync } from 'node:child_process'
import { checkPrBodyFrozen, type PrBodyFrozenComment } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../../lib/config'

const CHECK_NAME = 'pr-body-frozen'

/**
 * One `gh pr view` call for both the live body and the comments — comments
 * are never available from `PR_BODY` alone, so this fetch happens
 * regardless of whether `PR_BODY` is already set. `PR_BODY`, when set, is
 * used verbatim over the fetched body below (CI already resolved it once;
 * re-fetching it here would just be a second, possibly-inconsistent read).
 */
function fetchBodyAndComments(prNumber: number): { body: string; comments: PrBodyFrozenComment[] } | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'body,comments'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const parsed = JSON.parse(out) as { body: string; comments: { body: string; author?: { login?: string } | null }[] }
    return {
      body: parsed.body,
      comments: parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
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

  const fetched = fetchBodyAndComments(prNumber)
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

  const envBody = process.env.PR_BODY
  const body = envBody && envBody !== '' ? envBody : fetched.body
  if (!body) {
    // No PR body anywhere — ring 0, or a check run with nothing to evaluate.
    process.exit(0)
  }
  const comments = fetched.comments

  // Same trust anchor `checkReviewGate` uses — the repo's own `principals`
  // field on the default branch, never the PR's checkout.
  const principalAllowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())

  const result = checkPrBodyFrozen({ body, comments, principalAllowlist })

  if (result.status === 'fail') {
    for (const message of result.errors) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        agent_recovery_prompt:
          'The PR body is frozen at open per aeg-root/roles/developer.md — revert the body to what `pr create` posted (the AEG:EVIDENCE regeneration and one appended AEG:TOKENS row are the only exceptions), and answer review findings with commits and a round comment instead.'
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
