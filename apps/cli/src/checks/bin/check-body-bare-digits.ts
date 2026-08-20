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
 * Dormant on the Changesets release PR — not a reopened carve-out of the kind
 * this check's redesign closed. PREMISE/TEST-PLAN stayed unbounded because
 * they're where an *agent* freely narrates a claim; this PR's body is a
 * deterministic rendering of already-reviewed changeset files (each one
 * reviewed when the PR that added it went through review), written by
 * `github-actions[bot]`, never by an agent claiming something about its own
 * work. A different category of content, not a second exception for the
 * same failure mode.
 *
 * The skip requires BOTH the branch name AND the author to match. `branch`
 * comes from `BRANCH`/`git rev-parse` — attacker-choosable by design (anyone
 * can push a branch and name it whatever they want), which is fine as long
 * as `author` is the real gate. `author` is fetched live via `gh pr view` at
 * check-run time, never an env var — this check is bundled into
 * `vinaya-checks`, a required status check with no bypass actors, so its
 * exemption sits behind the same trust boundary `review-gate.ts` documents
 * taking three rounds to close for `principals`: a `pull_request`-triggered
 * workflow runs the PR's own copy of its YAML, so any env var this check
 * trusted could be a hardcoded literal an attacker's own workflow file chose
 * to set. An earlier version of this exemption trusted a `PR_AUTHOR` env var
 * (round 2 security review, PR #165) and would have reopened exactly that
 * hole, on a required, non-bypassable gate — worse than the same mistake on
 * `review-gate` alone, not narrower, once code review's finding was
 * accounted for. Fixed the same way, no accepted residual left.
 *
 * The predicate itself (`isChangesetsReleasePr`) is `@attalabs/aeg-core`'s,
 * the same one `check-review-gate.ts` uses — not a second, duplicate
 * implementation. Round 4 (code review, PR #165) found this file's OWN
 * duplicate hardcoded the expected author to `github-actions[bot]` with no
 * way for an adopter to override it, and this repo's real release PRs are
 * opened by a custom `RELEASE_TOKEN` (`.github/workflows/release.yml`)
 * whose owner is a real user login — the exemption had never matched this
 * repo's own release PRs, in any of the three prior rounds. Sharing the one
 * implementation, resolved via `resolveReleaseActor(loadTrustAnchorConfig())`
 * exactly like `principals`, means this can't drift out of sync with
 * `review-gate`'s copy again.
 */

import { execFileSync } from 'node:child_process'
import { isChangesetsReleasePr } from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolveReleaseActor } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { checkBareDigits } from '../body-bare-digits-logic'

const CHECK_NAME = 'body-bare-digits'

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

/** Live-fetched author only — never `process.env.PR_AUTHOR`. See module doc for why. */
function fetchPrAuthor(prNumber: number): string | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'author'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const parsed = JSON.parse(out) as { author?: { login?: string } | null }
    return parsed.author?.login ?? null
  } catch {
    return null
  }
}

const CHANGESET_RELEASE_BRANCH = 'changeset-release/main'

function isChangesetsReleasePrHere(branch: string, prNumberStr: string | undefined): boolean {
  // Cheap branch check first — no fetch cost on the overwhelmingly common
  // non-release-PR path, matching the original design's short-circuit.
  if (branch !== CHANGESET_RELEASE_BRANCH) return false
  if (!prNumberStr) return false
  const prNumber = Number(prNumberStr)
  if (!Number.isFinite(prNumber)) return false
  const author = fetchPrAuthor(prNumber)
  return isChangesetsReleasePr(branch, author, resolveReleaseActor(loadTrustAnchorConfig()))
}

function main(): void {
  const branch = process.env.BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (isChangesetsReleasePrHere(branch, process.env.PR_NUMBER)) {
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
