#!/usr/bin/env bun

/**
 * Core check: review-gate. Thin adapter over `@attalabs/aeg-core`'s
 * `checkReviewGate` — the input assembly it judges (PR comments/labels/
 * waiver-label-actor/head sha/base sha/policy/objectives version/brief hash via
 * `gh` and `git`) lives in `lib/review-gate-input.ts`'s
 * `assembleReviewGateInput`, shared with the dev-review-loop driver's own
 * "is this review concluded?" read so there is exactly one copy of it. This
 * file's own job is the check contract: turn that assembly's failures and the
 * gate's own verdict into the emitted shape, instead of human text.
 *
 * Why the assembly is shared rather than copied: it re-resolves policy and
 * principals from the DEFAULT BRANCH's trust anchor and the head from the
 * remote, and a second hand-built copy reading the pull request's own checkout
 * would drift — see that module's own header for the full reasoning, and for
 * the head sha's own rule (`git ls-remote`, never a caller-suppliable env var,
 * and never `gh pr view`'s `headRefOid`, which can lag a push; registry.ts's
 * own comment on this check's entry states the same prohibition).
 *
 * Documented divergences from the reference script
 * (`packages/aeg-core/bin/verify-review-gate.ts`), both unchanged by the
 * extraction:
 *
 *  - This path resolves a real `objectivesVersion` (Issue-then-body,
 *    fail-closed on every unresolvable case). `verify-review-gate.ts` always
 *    passes `objectivesVersion: null`, unconditionally skipping the
 *    objectives-version half of the binding, because it has no equivalent
 *    Issue-body-fetch machinery and is not this repo's live review-gate path.
 *    Any doc describing which code resolves the objectives-version binding
 *    must name `assembleReviewGateInput`, not the reference script.
 *  - `verify-review-gate.ts` fails CLOSED when `PR_NUMBER` is unset, because
 *    its only real caller (`forge-lifecycle.yml`) is triggered exclusively on
 *    an existing PR. This adapter is also reachable from a pre-push hook /
 *    local `vinaya check --all` run BEFORE a PR exists — failing closed there
 *    would block every push on a brand-new branch. No `PR_NUMBER` here instead
 *    bypasses (exit 0), the same "nothing to evaluate yet" shape
 *    `brief-shape`/`test-plan` already use for a missing `PR_BODY`.
 *
 * Reviews only. This adapter resolves no other check's result and reads no
 * Test Plan tick-state: every merge condition is its own independent check,
 * so that all green means mergeable, and a gate that re-reported a sibling
 * check's red answered a question it does not own. The principal Test Plan
 * wait is a check of its own; a red sibling check is already red on its own
 * name.
 *
 * scope: full — a review verdict is a property of the PR, not the diff.
 */

import { checkReviewGate } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { assembleReviewGateInput } from '../../lib/review-gate-input'

const CHECK_NAME = 'review-gate'

function main(): void {
  const prNumberStr = process.env.PR_NUMBER
  if (!prNumberStr) {
    // No PR to evaluate yet (local dev, pre-push before a PR exists).
    process.exit(0)
  }

  const prNumber = Number(prNumberStr)
  const assembly = assembleReviewGateInput(prNumber)
  if (!assembly.ok) {
    // Every unresolvable input fact fails this check closed — an unresolvable
    // head, base, policy, objectives version or frozen brief hash is a
    // binding disarmed, and the assembly's own resolvers carry the findings
    // that established that for each one.
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: assembly.failure.message,
      agent_recovery_prompt: assembly.failure.agentRecoveryPrompt
    })
    process.exit(1)
  }

  const result = checkReviewGate(assembly.input)

  if (result.verdict === 'fail') {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `review-gate (PR #${prNumber}): ${result.reason}`,
      agent_recovery_prompt:
        'Wait for a code-reviewer APPROVE and a security-review PASS on this PR (or ask a principal to apply the `vinaya/waiver:review` label), then re-run `vinaya check review-gate`.'
    })
    process.exit(1)
  }

  process.exit(0)
}

// Guarded so this module can be imported by unit tests without executing the
// check. Spawned as a bin (the only way it runs for real) this is still true.
if (import.meta.main) {
  main()
}
