#!/usr/bin/env bun

/**
 * Core check: body-bare-digits. Refuses a PR body that carries a bare digit
 * in narrative prose outside a fenced/indented/inline code span — see
 * `body-bare-digits-logic.ts`'s module doc for the full masking pipeline and
 * the exemption list it applies before counting a hit as a real violation.
 *
 * scope: diff, requiresOpenPr: true, PR_BODY optional (absence-tolerant) —
 * the same body-only shape as `closes-n`/`test-plan`/`evidence-fresh`
 * (`registry.ts`): this check reads only the PR body, never the diff or the
 * repo tree, and is meaningless before a PR (hence its body) exists.
 *
 * `ownWorkflow: true` (registry.ts): this bin runs ONLY from
 * `vinaya-body-checks.yml`'s `pull_request_target` job in CI — never from
 * `vinaya-checks.yml`'s `pull_request` job, and `vinaya check --all` omits
 * it for the same reason `review-gate` is omitted. This is load-bearing,
 * not incidental: the Changesets-release exemption below live-fetches the
 * PR's real author, keyed on `PR_NUMBER`. On a `pull_request` trigger the
 * PR's own workflow YAML controls that env value, so an attacker's PR could
 * redirect it to any already-approved PR by the configured release actor —
 * found live (round 5, security review, PR #165), reproduced, and verified
 * that no env-var or git-state signal inside that trigger type closes it.
 * `pull_request_target` closes it: the workflow text assigning `PR_NUMBER`
 * comes from the DEFAULT BRANCH, which a pull request cannot edit — see
 * `isChangesetsReleasePr`'s own doc comment (`@attalabs/aeg-core`) for the
 * full reasoning, and `vinaya-body-checks.yml`'s header for the workflow
 * side of the same boundary `vinaya-review.yml` already established.
 */

import { execFileSync } from 'node:child_process'
import { CHANGESET_RELEASE_BRANCH, isChangesetsReleasePr } from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolveReleaseActor } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { checkBareDigits } from '../body-bare-digits-logic'

const CHECK_NAME = 'body-bare-digits'

type PrView = { number: number; headRefName: string; author?: { login?: string } | null }

/** Live-fetched branch/author only — never an env var. See module doc for why. */
function fetchPr(prNumber: number): PrView | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'number,headRefName,author'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return JSON.parse(out) as PrView
  } catch {
    return null
  }
}

function isExemptChangesetsReleasePr(prNumberStr: string | undefined): boolean {
  if (!prNumberStr) return false
  const prNumber = Number(prNumberStr)
  if (!Number.isFinite(prNumber)) return false
  const pr = fetchPr(prNumber)
  if (!pr || pr.headRefName !== CHANGESET_RELEASE_BRANCH) return false
  // Only reached once the branch already matches — `resolveReleaseActor`
  // triggers a SECOND network round-trip (the trust-anchor `vinaya.config.json`
  // fetch), which must not run on every ordinary PR just because it is one
  // of `isChangesetsReleasePr`'s three arguments. Found live (code review,
  // PR #169): JS evaluates function arguments eagerly, so inlining it there
  // paid that fetch unconditionally, regardless of branch.
  return isChangesetsReleasePr(pr.headRefName, pr.author?.login ?? null, resolveReleaseActor(loadTrustAnchorConfig()))
}

function main(): void {
  if (isExemptChangesetsReleasePr(process.env.PR_NUMBER)) {
    // Machine-rendered changelog, not agent-narrated prose — see module doc.
    process.exit(0)
  }

  const body = process.env.PR_BODY ?? ''
  if (!body) {
    // No PR body — ring 0, or a check run with nothing to evaluate. Same
    // dormancy discipline as every other body-only check in this registry.
    process.exit(0)
  }

  const result = checkBareDigits(body)
  if (result.violations.length === 0) {
    process.exit(0)
  }

  for (const v of result.violations) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `body-bare-digits: bare digit outside a fenced block, line ${v.line}: ${v.text}`,
      agent_recovery_prompt:
        'Move this into a fenced code block, or state it as a symbol reference instead of a narrative claim (e.g. `N`), then re-run `vinaya check body-bare-digits`.',
      line: v.line
    })
  }
  process.exit(1)
}

main()
