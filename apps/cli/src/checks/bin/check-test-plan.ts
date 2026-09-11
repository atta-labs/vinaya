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

import { evaluateTestPlanGate, type TestPlanGateResult } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError, emitCheckError } from '../contract'

const CHECK_NAME = 'test-plan'

/**
 * Classifies a fail result into this check's `CheckError`s, exported for
 * direct unit coverage of the pending/structural split (review-validity-v1
 * 11, O1) rather than only through a spawned end-to-end run. Two
 * distinguishable causes share this one check. A missing Test Plan section
 * is structural — the Developer fixes it by writing one, and it always
 * blocks the mechanical gate. An unticked `[principal]` item is a wait
 * state — only the Principal clears it, by verifying in a real signed-in
 * browser and ticking the box — so it is marked `pending: true` (see
 * `CheckSpec.principalOwed`'s doc comment) rather than left indistinguishable
 * from the structural case. `evaluateTestPlanGate` itself exposes no cause
 * field (its result type is unchanged, out of this task's surface), so the
 * class is read off its own message text, verbatim per that module's doc
 * comment. Returns `[]` for a `pass` result.
 */
export function buildTestPlanCheckErrors(result: TestPlanGateResult): CheckError[] {
  if (result.verdict !== 'fail') return []
  const principalPending = result.messages.some((m) =>
    m.startsWith('FAIL — the following [principal] Test Plan items are unticked:')
  )
  const errors: CheckError[] = []
  for (const message of result.messages) {
    if (!message) continue
    errors.push({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message,
      agent_recovery_prompt: principalPending
        ? 'Nothing for the Developer to fix here — wait for the Principal to verify in a real signed-in browser and tick each `[principal]` Test Plan box, then re-run `vinaya check test-plan`.'
        : 'Add a `## Test Plan` section to the PR body (or the `Test Plan: unit-tests-only` sentinel for a pure-logic brief with no runtime surface), then re-run `vinaya check test-plan`.',
      ...(principalPending ? { pending: true as const } : {})
    })
  }
  return errors
}

function main(): void {
  const body = process.env.PR_BODY ?? ''
  const branch = process.env.BRANCH ?? ''

  const result = evaluateTestPlanGate(body, branch)
  const errors = buildTestPlanCheckErrors(result)

  if (errors.length > 0) {
    for (const error of errors) emitCheckError(error)
    process.exit(1)
  }

  process.exit(0)
}

// Guarded so this module can be imported by unit tests without executing the
// check. Spawned as a bin (the only way it runs for real) this is still true.
if (import.meta.main) {
  main()
}
