#!/usr/bin/env bun

/**
 * Core check: single-plan-pr. Thin adapter over `@attalabs/aeg-core`'s
 * `checkSinglePlanPr` — mirrors `packages/aeg-core/bin/verify-single-plan-pr.ts`'s
 * predicate (does this branch's diff touch a tranche topology file that
 * some OTHER open PR's diff also touches), emitting the check contract
 * instead of human text.
 *
 * Narrower than the reference script in one respect, documented rather than
 * silently equivalent: the reference script fetches ITS OWN PR's files via
 * `gh pr view <PR_NUMBER>`. This adapter instead diffs the local branch
 * against `base` directly (same `git diff` pattern every other diff-scoped
 * adapter here uses) so it also works pre-PR (`vinaya check` run locally
 * before a PR exists, e.g. from a pre-push hook) — the reference script
 * requires `PR_NUMBER` and cannot run pre-PR at all.
 *
 * A failed `gh pr list` read degrades to "no other open PRs known" only when
 * it is not a rate limit (auth, network, malformed output) — a transient
 * forge outage must never fabricate a false conflict. A rate limit is
 * different: GitHub refused to answer, so an empty list would be a pass
 * nobody checked. The check fails instead, naming the budget and when it
 * resets.
 *
 * scope: diff — a plan PR is defined entirely by what its diff touches.
 */

import { execFileSync } from 'node:child_process'
import { checkSinglePlanPr, touchesAnyTopology, type OpenPrFiles } from '@attalabs/aeg-core'
import { execErrorText, isGithubRateLimitError, rateLimitMessage } from '../../lib/github-rate-limit'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'single-plan-pr'

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function changedFiles(base: string): string[] {
  return git(['diff', '--name-only', `${base}...HEAD`])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function fetchOtherOpenPrFiles(excludePrNumber: number | null): OpenPrFiles[] {
  let out: string
  try {
    out = execFileSync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,files'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const text = execErrorText(err)
    if (isGithubRateLimitError(text)) failRateLimited(text)
    return []
  }
  let all: Array<{ number: number; files: Array<{ path: string }> }>
  try {
    all = JSON.parse(out)
  } catch {
    return []
  }
  return all
    .filter((pr) => pr.number !== excludePrNumber)
    .map((pr) => ({ number: pr.number, files: pr.files.map((f) => f.path) }))
}

function failRateLimited(errorText: string): never {
  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check: CHECK_NAME,
    severity: 'error',
    message: `single-plan-pr: could not read the open pull requests — ${rateLimitMessage(errorText)}.`,
    agent_recovery_prompt:
      'GitHub refused the open pull request read on a rate limit, so no conflict check ran. Re-run `vinaya check single-plan-pr` after the reset time.'
  })
  process.exit(1)
}

function main(): void {
  const base = process.env.BASE_SHA || 'origin/main'
  let branchFiles = changedFiles(base)
  if (branchFiles.length === 0) branchFiles = changedFiles('main')

  if (!touchesAnyTopology(branchFiles)) {
    process.exit(0)
  }

  const excludePrNumber = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null
  const otherOpenPrs = fetchOtherOpenPrFiles(excludePrNumber)
  const result = checkSinglePlanPr(branchFiles, otherOpenPrs)

  if (!result.ok) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: result.message ?? 'single-plan-pr check failed',
      agent_recovery_prompt:
        'Another open PR already touches this tranche topology file. Wait for it to merge, or coordinate with its author, then re-run `vinaya check single-plan-pr`.'
    })
    process.exit(1)
  }

  process.exit(0)
}

main()
