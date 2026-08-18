#!/usr/bin/env bun

/**
 * Core check: evidence-fresh (fix/pr-report-emitter). Refuses a PR body whose
 * `AEG:EVIDENCE` block does not match the head it is attached to.
 *
 * Two asymmetric halves, on purpose — see `evidence-fresh-logic.ts`'s module
 * doc for the fabrication-vs-staleness boundary this closes:
 *   - Group A (the `git diff --numstat` recompute) is compared exactly.
 *   - Group B (the attested `vinaya check --all --diff-only` run) is checked
 *     for freshness only, via the block's `Head:` line — re-running that
 *     suite here would be the recursion `vinaya pr report`'s own docstring
 *     rejects.
 *
 * Head resolution deliberately does NOT use `HEAD`. `actions/checkout@v4` on
 * a `pull_request` event with no `ref:` checks out `refs/pull/N/merge`, so
 * `HEAD` in CI is the merge commit, never the PR head — using it would
 * red-line every PR that adopts this anchor. The emitter
 * (`apps/cli/src/commands/pr-report.ts`) runs locally, before the PR exists,
 * where `git rev-parse HEAD` IS the real head; this check runs in CI, so it
 * self-resolves the real head via `gh pr view --json headRefOid`, the same
 * pattern already live at `.github/workflows/vinaya-review-verdict.yml:47`
 * and `apps/cli/src/lib/artifacts.ts`. Every recomputation is anchored on
 * that resolved sha, not on `HEAD` — a `git diff origin/main...HEAD` in CI
 * would resolve the merge base to `origin/main`'s tip rather than the fork
 * point, spuriously red-lining any PR whose base has since advanced over
 * overlapping files.
 *
 * scope: diff — the whole point is "does this PR body's evidence match this
 * PR's own head." requiresOpenPr: true — meaningless before a PR exists,
 * same reasoning as `closes-n`/`test-plan`.
 */

import { execFileSync } from 'node:child_process'
import { anchoredRegion } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { compareEvidenceBlock } from '../evidence-fresh-logic'

const CHECK_NAME = 'evidence-fresh'

// Array-form execFileSync — no shell, so no injection surface.
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function fetchHeadSha(prNumber: number): string | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'headRefOid', '-q', '.headRefOid'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function main(): void {
  const body = process.env.PR_BODY ?? ''
  if (!body) {
    // No PR body — ring 0, or a check run with nothing to evaluate.
    process.exit(0)
  }

  const region = anchoredRegion(body, 'EVIDENCE')
  if (region === null) {
    // The anchor is opt-in, like every other AEG anchor — a body that
    // hasn't adopted it yet is not broken by not adopting it.
    process.exit(0)
  }

  const prNumberStr = process.env.PR_NUMBER
  if (!prNumberStr) {
    // No PR yet to resolve a real head against (local dev, pre-push).
    process.exit(0)
  }

  const resolvedHead = fetchHeadSha(Number(prNumberStr))
  if (resolvedHead === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `evidence-fresh: could not resolve PR #${prNumberStr}'s head via \`gh pr view --json headRefOid\`.`,
      agent_recovery_prompt:
        'Confirm `gh auth status` passes and PR_NUMBER is correct, then re-run `vinaya check evidence-fresh`.'
    })
    process.exit(1)
  }

  const base = git(['merge-base', 'origin/main', resolvedHead])
  const actualNumstat = base ? git(['diff', `${base}...${resolvedHead}`, '--numstat']) : ''

  const result = compareEvidenceBlock(region, resolvedHead, actualNumstat)
  if (result.status === 'fail') {
    for (const message of result.errors) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        agent_recovery_prompt:
          'Re-run `vinaya pr report --write <body-file>` against the current head, commit, and push again.'
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
