#!/usr/bin/env bun

/**
 * Core check: principal-test-plan-wait. Owns the merge condition an unticked
 * `[principal]` Test Plan item represents — its own independent check, red
 * until the Principal ticks the box, so that "all green" genuinely means
 * mergeable rather than requiring a reviewer to notice a red `review-gate`
 * line buried among several other reasons that check can fail.
 *
 * Reuses `evaluateTestPlanGate` (`@attalabs/aeg-core`) — the exact same
 * tick-detection logic `check-test-plan.ts` runs — rather than
 * reimplementing the checkbox scan, so the two checks can never disagree
 * about which lines are unticked. Only the `[principal]`-unticked branch of
 * that function's result is graded here: a missing Test Plan section is
 * `test-plan`'s own structural failure to grade (this check reports nothing
 * for it, the same "nothing to refuse" split `check-review-gate.ts`'s own
 * `uncheckedPrincipalReason` used before this check existed to take over its
 * job), and `test-plan` keeps grading the `[agent]` half and the plan's
 * structure unchanged.
 *
 * Reported by its own job in `vinaya-body-checks.yml` (`ownWorkflow: true`)
 * — never by the aggregate `check --all`, so its red can never turn another
 * check's name red. That workflow's own `on: pull_request_target: types:
 * [opened, reopened, edited]` trigger is what re-evaluates this check when
 * the PR body is edited — ticking a box re-runs it, unlike the review-gate
 * path this check replaces, where an edit triggered nothing.
 *
 * Body and branch only — `process.env.PR_BODY ?? ''` / `process.env.BRANCH
 * ?? ''`, the same absence-tolerant fall-throughs `check-test-plan.ts`
 * already uses. `BRANCH` only ever affects the structural (no-section)
 * branch of `evaluateTestPlanGate`'s result, which this check never reports
 * on, so its absence changes nothing this check emits.
 *
 * scope: diff — reads only the PR body, never the whole repo.
 */

import { evaluateTestPlanGate } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError, emitCheckError } from '../contract'

const CHECK_NAME = 'principal-test-plan-wait'

/**
 * `[]` when there is nothing to refuse: every `[principal]` item is ticked
 * or none exist, or the fail is the OTHER (structural, no-section) branch —
 * that one is `test-plan`'s to grade. Exported for direct unit coverage of
 * the split rather than only through a spawned end-to-end run.
 */
export function buildPrincipalTestPlanWaitErrors(body: string, branch: string): CheckError[] {
  const result = evaluateTestPlanGate(body, branch)
  if (result.verdict !== 'fail') return []
  const uncheckedLines = result.messages.filter((m) => /^\s*[-*]\s+\[\s\]/.test(m)).map((m) => m.trim())
  if (uncheckedLines.length === 0) return []
  return [
    {
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `principal-test-plan-wait: unticked [principal] Test Plan item(s) — ${uncheckedLines.join('; ')}`,
      agent_recovery_prompt:
        'Nothing for the Developer to fix here — wait for the Principal to verify in a real signed-in browser and tick each `[principal]` Test Plan box, then re-run `vinaya check principal-test-plan-wait`.',
      pending: true
    }
  ]
}

function main(): void {
  const body = process.env.PR_BODY ?? ''
  const branch = process.env.BRANCH ?? ''

  const errors = buildPrincipalTestPlanWaitErrors(body, branch)

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
