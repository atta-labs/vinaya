#!/usr/bin/env bun

/**
 * Core check: pr-report-density. Thin adapter over `@attalabs/aeg-core`'s
 * `checkPrReportDensity` — reads `PR_BODY` and emits the check contract.
 *
 * scope: diff — reads only the PR body, never the whole repo.
 */

import { checkPrReportDensity } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'pr-report-density'

function main(): void {
  const prBody = process.env.PR_BODY ?? ''
  if (!prBody) {
    // No PR body to check (local dev outside a CI/PR context) — nothing to do.
    process.exit(0)
  }

  const { errors } = checkPrReportDensity(prBody)

  if (errors.length > 0) {
    for (const message of errors) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        agent_recovery_prompt:
          'Collapse the named section to exactly one paragraph, then re-run `vinaya check pr-report-density`.'
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
