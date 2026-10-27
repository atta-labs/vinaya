/**
 * The Log events of review locally, push once (the developer-review flow's
 * version 2), and the per-phase time both flows record. Builders only: each
 * returns an event without its envelope, and the runner that owns the sink
 * writes it. Kept in one file so the event names and their fields have one
 * home that the Log coverage check reads.
 */
import type { DevReviewLoopEventInput } from '@attalabs/aeg-core'

type Loop = { loopId: string; round: number }

const base = (loop: Loop) => ({
  kind: 'dev_review_loop' as const,
  payload: {},
  loop_id: loop.loopId,
  round: loop.round
})

/** One Developer push to the task branch while no pull request is open: cheap checks only, no tests, no CI. */
export function storagePushEvent(loop: Loop, branch: string, head: string): DevReviewLoopEventInput {
  return { ...base(loop), event: 'storage_push', branch, head } as DevReviewLoopEventInput
}

/** The round's local gate: whether it passed and how long it took. */
export function localChecksRunEvent(
  loop: Loop,
  head: string | null,
  passed: boolean,
  wallMs: number
): DevReviewLoopEventInput {
  return { ...base(loop), event: 'local_checks_run', head, passed, wall_ms: wallMs } as DevReviewLoopEventInput
}

/** The push after both reviewers approved: the tests it selected, how many failed, and whether it was a re-run. */
export function readyPushEvent(
  loop: Loop,
  fields: {
    head: string
    outcome: 'passed' | 'refused'
    selected: number
    failed: number
    rerun: boolean
    wallMs: number
  }
): DevReviewLoopEventInput {
  return {
    ...base(loop),
    event: 'ready_push',
    head: fields.head,
    outcome: fields.outcome,
    selected: fields.selected,
    failed: fields.failed,
    rerun: fields.rerun,
    wall_ms: fields.wallMs
  } as DevReviewLoopEventInput
}

/** A push that ran only the tests a refused push failed plus those its fix affects, instead of the whole selection. */
export function failedTestsRerunEvent(
  loop: Loop,
  fields: { head: string; rerunOf: string; failedFiles: number; affectedFiles: number; fullCount: number }
): DevReviewLoopEventInput {
  return {
    ...base(loop),
    event: 'failed_tests_rerun',
    head: fields.head,
    rerun_of: fields.rerunOf,
    failed_files: fields.failedFiles,
    affected_files: fields.affectedFiles,
    full_count: fields.fullCount
  } as DevReviewLoopEventInput
}

/** The pull request the approved head opened. */
export function prOpenedEvent(loop: Loop, pr: number, head: string): DevReviewLoopEventInput {
  return { ...base(loop), event: 'pr_opened', pr, head } as DevReviewLoopEventInput
}

/** The one CI read of an approved head. */
export function ciResultReadEvent(
  loop: Loop,
  fields: {
    pr: number
    head: string
    conclusion: 'green' | 'red' | 'pending' | 'skipped'
    failingChecks: string[]
    waitMs: number
  }
): DevReviewLoopEventInput {
  return {
    ...base(loop),
    event: 'ci_result_read',
    pr: fields.pr,
    head: fields.head,
    conclusion: fields.conclusion,
    failing_checks: fields.failingChecks,
    wait_ms: fields.waitMs
  } as DevReviewLoopEventInput
}

/** The phases a step's time counts toward. */
export type FlowPhase = 'developer' | 'local_checks' | 'review' | 'push' | 'ci' | 'other'

/** The wall time one step spent, counted toward its phase; written by both flows. */
export function phaseTimeEvent(loop: Loop, phase: FlowPhase, step: string, wallMs: number): DevReviewLoopEventInput {
  return { ...base(loop), event: 'phase_time', phase, step, wall_ms: wallMs } as DevReviewLoopEventInput
}

/**
 * The phase a step of either developer-review flow belongs to. Agent steps are
 * the developer and the review; the gates and checks run on the head are local
 * checks (in version 1 the gate step also waits on CI, which it reads as part
 * of the gate, so version 1's CI time sits in `ci` through its own CI step);
 * the ready push and the pull request's opening are the push.
 */
export function phaseOfStep(step: string): FlowPhase {
  switch (step) {
    case 'develop':
    case 'validate-developer-output':
    case 'classify-developer-output':
      return 'developer'
    case 'run-mechanical-gates':
    case 'check-premise':
    case 'assess-gate':
    case 'classify-gate-result':
    case 'run-live-checks':
    case 'classify-live-result':
    case 'run-security-scan':
      return 'local_checks'
    case 'dispatch-reviewers':
    case 'code-review':
    case 'security-review':
    case 'validate-reviewer-outputs':
    case 'classify-reviewer-outputs':
    case 'assess-round':
    case 'build-revision-handoff':
      return 'review'
    case 'ready-push':
    case 'classify-ready-push':
    case 'open-pull-request':
    case 'publish-ready-for-merge':
      return 'push'
    case 'read-forge-ci':
    case 'read-ci-once':
    case 'assess-ci':
    case 'classify-ci-result':
    case 'check-mergeability':
    case 'classify-mergeability':
    case 'check-publish-mergeability':
    case 'classify-publish-mergeability':
      return 'ci'
    default:
      return 'other'
  }
}
