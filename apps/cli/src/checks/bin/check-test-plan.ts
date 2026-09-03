#!/usr/bin/env bun

/**
 * Core check: test-plan. Thin adapter over `@attalabs/aeg-core`'s
 * `evaluateTestPlanGate` — mirrors `packages/aeg-core/bin/verify-test-plan.ts`'s
 * input assembly (PR_BODY/BRANCH env) exactly, emitting the check contract
 * instead of human text.
 *
 * Body and branch only, again (task 12, #387) — the comment fetch and
 * `PR_NUMBER` use this bin carried between #365 and #387 existed to count
 * Developer round comments backing a ticked `[agent]` checkbox. That
 * checkbox no longer exists: the `[agent]` half of a Test Plan is a fenced
 * command list `vinaya pr report` executes and writes into the
 * `AEG:EVIDENCE` block itself, so there is no tick left to demand evidence
 * for. `evaluateTestPlanGate` now grades `[principal]` boxes only, and grades
 * them from the body alone — see that module's own doc comment.
 *
 * scope: diff — reads only the PR body, never the whole repo.
 */

import { evaluateTestPlanGate } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'test-plan'

function main(): void {
  const body = process.env.PR_BODY ?? ''
  const branch = process.env.BRANCH ?? ''

  const result = evaluateTestPlanGate(body, branch)

  if (result.verdict === 'fail') {
    for (const message of result.messages) {
      if (!message) continue
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        agent_recovery_prompt:
          'Run each `[agent]` Test Plan command from the PR head and let `vinaya pr report` write its output into the AEG:EVIDENCE block; leave `[principal]` boxes for the Principal to tick after verifying in a real signed-in browser. Re-run `vinaya check test-plan` afterwards.'
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
