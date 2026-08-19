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
 */

import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { checkBareDigits } from '../body-bare-digits-logic'

const CHECK_NAME = 'body-bare-digits'

function main(): void {
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
