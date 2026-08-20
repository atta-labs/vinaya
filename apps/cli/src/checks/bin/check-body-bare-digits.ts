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
 * The skip requires BOTH the branch name AND the author to match — branch
 * name alone is not a trust boundary. `BRANCH`/`PR_AUTHOR` come from
 * `github.head_ref`/`github.event.pull_request.user.login`, set into the env
 * block by this repo's OWN `vinaya-checks.yml` — and a `pull_request`-
 * triggered workflow runs the PR's own copy of that YAML, so an attacker's
 * PR can replace either expression with a hardcoded literal, same class of
 * hole `review-gate.ts`'s own module comment documents taking three rounds
 * to close for `principals`. Deliberately NOT fixed the same way here (a
 * live forge fetch at check-run time, like `check-review-gate.ts`'s
 * `fetchPr` now does) — this check's worst case if spoofed is a stray
 * unformatted digit slipping
 * past ONE check, not an unreviewed merge: `review-gate` (the actual
 * merge-blocking gate) resolves its own author check unspoofably and is the
 * real backstop regardless of this one. Paying for a network call on every
 * run of an otherwise-pure, fast check isn't proportionate to that residual.
 * Revisit if this check ever becomes merge-blocking on its own.
 */

import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { checkBareDigits } from '../body-bare-digits-logic'

const CHECK_NAME = 'body-bare-digits'
const CHANGESET_RELEASE_BRANCH = 'changeset-release/main'
const CHANGESET_RELEASE_AUTHOR = 'github-actions[bot]'

function main(): void {
  if (process.env.BRANCH === CHANGESET_RELEASE_BRANCH && process.env.PR_AUTHOR === CHANGESET_RELEASE_AUTHOR) {
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
