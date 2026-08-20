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
 * Dormant on the Changesets release PR (`changeset-release/main`, the fixed
 * branch name that action always force-pushes to) — not a reopened carve-out
 * of the kind this check's redesign closed. PREMISE/TEST-PLAN stayed
 * unbounded because they're where an *agent* freely narrates a claim; this
 * PR's body is a deterministic rendering of already-reviewed changeset files
 * (each one reviewed when the PR that added it went through review), written
 * by `github-actions[bot]`, never by an agent claiming something about its
 * own work. A different category of content, not a second exception for the
 * same failure mode.
 */

import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { checkBareDigits } from '../body-bare-digits-logic'

const CHECK_NAME = 'body-bare-digits'
const CHANGESET_RELEASE_BRANCH = 'changeset-release/main'

function main(): void {
  if (process.env.BRANCH === CHANGESET_RELEASE_BRANCH) {
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
