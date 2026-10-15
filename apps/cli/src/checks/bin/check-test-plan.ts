#!/usr/bin/env bun

/**
 * Core check: test-plan. Thin adapter over `@attalabs/aeg-core`'s
 * `evaluateTestPlanGate` — mirrors `packages/aeg-core/bin/verify-test-plan.ts`'s
 * input assembly (PR_BODY/BRANCH env), emitting the check contract instead
 * of human text.
 *
 * On a task branch it also reads the task Issue's newest frozen brief
 * (`resolveTaskFrozenBrief`, shared with `brief-shape`) for its `[live]`
 * lines (`parseLiveTestPlanItems`), and hands them to the gate with the pull
 * request's head SHA (`PR_HEAD_SHA` — the pull request's own head, never the
 * merge ref a `pull_request` run checks out), so each `[live]` line with no
 * passed `AEG:LIVE` entry at that head fails the check. It fails closed: a
 * brief it cannot read — any fetch error, a not-found Issue included — fails
 * the check, since the lines the merge must wait for are then unknown.
 *
 * scope: diff — reads the PR body and the task Issue's comments, never the
 * whole repo.
 */

import {
  evaluateTestPlanGate,
  isEntryPoint,
  isTaskBranch,
  parseLiveTestPlanItems,
  type TestPlanGateResult
} from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError, emitCheckError } from '../contract'
import { type IssueComment, resolveTaskFrozenBrief } from '../frozen-brief'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../../lib/config'
import { readIssueComments } from '../../lib/forge-read'

const CHECK_NAME = 'test-plan'

/**
 * Classifies a fail result into this check's `CheckError`s, exported for
 * direct unit coverage of the pending/structural split rather than only
 * through a spawned end-to-end run. Two distinguishable causes share this
 * one check. A missing Test Plan section
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

/** What the check reads: the PR body, its branch, and the pull request's head SHA. */
export type TestPlanCheckInputs = { body: string; branch: string; head: string }

/** The forge reads behind the frozen-brief resolution — injected so a test can make one throw. */
export type TestPlanCheckDeps = {
  fetchIssueComments: (issue: number) => IssueComment[]
  principalAllowlist: () => readonly string[]
}

const defaultDeps: TestPlanCheckDeps = {
  fetchIssueComments: (issue) => readIssueComments(issue, `Issue #${issue}`),
  principalAllowlist: () => resolvePrincipalAllowlist(loadTrustAnchorConfig())
}

/**
 * The check's errors for one run, `[]` on a pass. A non-task branch, or an
 * empty body, is graded on the body alone, as it always was. A task branch
 * is graded against its frozen brief's `[live]` lines at `head`; a brief
 * that cannot be resolved is one blocking error — never pending, and never
 * the exemption `brief-shape` gives a not-found Issue.
 */
export function runTestPlanCheck(inputs: TestPlanCheckInputs, deps: TestPlanCheckDeps = defaultDeps): CheckError[] {
  const { body, branch, head } = inputs
  if (!body || !isTaskBranch(branch)) return buildTestPlanCheckErrors(evaluateTestPlanGate(body, branch))

  const brief = resolveTaskFrozenBrief(
    body,
    deps.fetchIssueComments,
    deps.principalAllowlist,
    "learn its frozen brief's `[live]` lines"
  )
  if (!brief.ok) {
    return [
      {
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message: `test-plan: ${brief.message} The \`[live]\` lines this pull request must have passed are unknown, so the check fails closed.`,
        agent_recovery_prompt:
          'Check `gh auth status` and network, and that the task Issue carries its frozen `aeg:brief:v<k>` comment, then re-run `vinaya check test-plan`.'
      }
    ]
  }
  const liveCommands = parseLiveTestPlanItems(brief.content)
  return buildTestPlanCheckErrors(evaluateTestPlanGate(body, branch, { liveCommands, head }))
}

function main(): void {
  const errors = runTestPlanCheck({
    body: process.env.PR_BODY ?? '',
    branch: process.env.BRANCH ?? '',
    head: process.env.PR_HEAD_SHA ?? ''
  })

  if (errors.length > 0) {
    for (const error of errors) emitCheckError(error)
    process.exit(1)
  }

  process.exit(0)
}

// Guarded so this module can be imported by unit tests without executing the
// check. Spawned as a bin (the only way it runs for real) this is still true.
if (isEntryPoint(import.meta.url, 'check-test-plan')) {
  main()
}
