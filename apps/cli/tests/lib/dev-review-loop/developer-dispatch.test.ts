import { describe, expect, it } from 'vitest'
import {
  developerBranchFor,
  launchNeverSpawned,
  reconcileLaunch,
  type ReconcileLaunchDeps
} from '../../../src/lib/dev-review-loop/developer-dispatch'
import type { LaunchRecord, ParsedLaunch } from '../../../src/lib/dispatch'

// task-run-v1 task 15, O1: `developerBranchFor` derives `task/issue-<n>` for
// a backlog Issue (no `[<tranche>] <n> — …` title, no `vinaya/tranche:*`
// label) instead of throwing — the same function, extended to a second
// branch shape, never a synthetic tranche.

describe('developerBranchFor', () => {
  it('derives task/<tranche>/<n> from a tranche-shaped title', () => {
    const branch = developerBranchFor(
      521,
      () => '[task-run-v1] 15 — A backlog Issue runs like a task',
      () => ['vinaya/tranche:task-run-v1']
    )
    expect(branch).toBe('task/task-run-v1/15')
  })

  it('derives task/issue-<n> for a backlog Issue with no tranche-shaped title or label', () => {
    const branch = developerBranchFor(
      600,
      () => 'Fix the flaky retry loop',
      () => []
    )
    expect(branch).toBe('task/issue-600')
  })

  it('throws when the title fails to parse but the Issue still carries a tranche label — a real defect, not a backlog Issue', () => {
    expect(() =>
      developerBranchFor(
        601,
        () => 'not a tranche-shaped title',
        () => ['vinaya/tranche:some-tranche']
      )
    ).toThrow(/does not match the `\[<tranche>\] <n> — …` shape, but it carries a vinaya\/tranche:\* label/)
  })

  // `#548` v3, O3: the label decides, never the title. An unlabeled backlog
  // Issue whose title happens to look tranche-shaped (copy-paste, or a
  // coincidence) must still poll `task/issue-<n>` — the OLD code checked the
  // title first and would have derived `task/some-slug/1` here instead.
  it('derives task/issue-<n> for an unlabeled Issue even when its title is tranche-shaped', () => {
    const branch = developerBranchFor(
      602,
      () => '[some-slug] 1 — looks like a tranche task but carries no tranche label',
      () => []
    )
    expect(branch).toBe('task/issue-602')
  })
})

// A launch refused before any vendor
// process started has no session AND no turn state to lose, so recovery
// dispatches a fresh developer session instead of pausing the task forever;
// a launch that DID spawn and lost its session still pauses, unchanged.

const RECOVERY_HOST = 'recovery-test-host'

/** A launch record whose defaults describe a cleanly finished, session-bound launch; each case overrides only the lifecycle facts it exercises. */
function launchRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    runId: 'run-1',
    role: 'developer',
    agent: 'claude',
    repo: { owner: 'acme', repo: 'widgets' },
    task: 734,
    pr: null,
    round: 1,
    attempt: 2,
    effectId: 'eff-1',
    dispatcherPid: 1000,
    childPid: 2000,
    childStartedAt: null,
    childCommand: null,
    host: RECOVERY_HOST,
    startedAt: '2026-09-26T00:00:00.000Z',
    status: 'completed',
    resumeId: 'sess-1',
    boundAt: '2026-09-26T00:00:01.000Z',
    finishedAt: '2026-09-26T00:00:02.000Z',
    failureReason: null,
    ...overrides
  }
}

/** Deps that find no process at all — every case below reconciles a launch that is already over. */
const noProcess: ReconcileLaunchDeps = {
  isPidAlive: () => false,
  hostname: () => RECOVERY_HOST,
  getProcessSnapshot: () => null,
  terminateChild: () => {}
}

/** The pre-spawn refusal shape `dispatchRole` writes: a terminal record, a reason, and no child pid ever stamped. */
function preSpawnRefusal(failureReason: LaunchRecord['failureReason']): { status: 'ok'; record: LaunchRecord } {
  return {
    status: 'ok',
    record: launchRecord({
      status: 'interrupted',
      failureReason,
      childPid: null,
      childStartedAt: null,
      childCommand: null,
      resumeId: null,
      boundAt: null,
      finishedAt: '2026-09-26T00:00:02.000Z'
    })
  }
}

describe('reconcileLaunch — a launch refused before any process started (O1/O2)', () => {
  it.each([['authentication-failed'], ['startup-failed'], ['hook-setup-failed'], ['refused']] as const)(
    'a pre-spawn %s refusal dispatches fresh — never the continuity pause',
    (failureReason) => {
      const out = reconcileLaunch(preSpawnRefusal(failureReason), { requireContinuity: true }, noProcess)
      expect(out.kind).toBe('fresh')
    }
  )

  it('is decided from the record, not from the reason string — an unrecognised future pre-spawn reason needs no new case', () => {
    // `launchNeverSpawned` is the whole decision, and it never reads which
    // reason the record carries: a reason this code has never heard of, on
    // the same never-spawned lifecycle shape, still dispatches fresh.
    expect(launchNeverSpawned(preSpawnRefusal('connection-failed').record)).toBe(true)
  })

  it('a launch that DID spawn and lost its session still pauses — continuity is only waived when there was none', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: launchRecord({ status: 'interrupted', failureReason: 'crash', resumeId: null, boundAt: null })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, noProcess)
    expect(out.kind).toBe('pause')
    if (out.kind === 'pause') expect(out.detail).toContain('would lose worker continuity')
  })

  it('a launch interrupted before its pid was ever stamped is possibly-spawned, and still pauses', () => {
    // The dispatcher died in the window between `spawn` returning and the
    // pid being stamped: the record never reached a terminal state, so
    // "no pid on record" is not proof that nothing ran.
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: launchRecord({ status: 'launched', failureReason: null, childPid: null, resumeId: null, boundAt: null })
    }
    expect(launchNeverSpawned(parsed.record)).toBe(false)
    expect(reconcileLaunch(parsed, { requireContinuity: true }, noProcess).kind).toBe('pause')
  })

  it('a pre-spawn refusal whose session was somehow bound still resumes that exact session', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: launchRecord({ status: 'interrupted', failureReason: 'authentication-failed', resumeId: 'sess-live' })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, noProcess)
    expect(out.kind).toBe('resume')
  })
})
