import { describe, expect, it } from 'vitest'
import {
  classifyChildLiveness,
  reconcileLaunch,
  type ReconcileLaunchDeps
} from '../../../src/lib/dev-review-loop/developer-dispatch'
import type { LaunchRecord, ParsedLaunch } from '../../../src/lib/dispatch'

const THIS_HOST = 'test-host'

/** A launch record with sensible defaults; individual cases override only what they exercise. */
function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    runId: 'run-1',
    role: 'developer',
    agent: 'claude',
    repo: { owner: 'acme', repo: 'widgets' },
    task: 42,
    pr: null,
    round: 1,
    attempt: 1,
    effectId: 'eff-1',
    dispatcherPid: 1000,
    childPid: 2000,
    host: THIS_HOST,
    startedAt: '2026-09-14T00:00:00.000Z',
    status: 'completed',
    resumeId: 'sess-1',
    boundAt: '2026-09-14T00:00:01.000Z',
    finishedAt: '2026-09-14T00:00:02.000Z',
    failureReason: null,
    ...overrides
  }
}

/**
 * Deps whose pid-liveness answer, hostname, and ppid answer are fixed per
 * case. `isAlive` drives both `isPidAlive` (probed for the dispatcher pid by
 * `classifyChildLiveness`) and whether `getPpid` finds anything at all at the
 * queried (child) pid — `ppid` names what it finds when it does, defaulting
 * to `record()`'s own default `dispatcherPid` (1000) so every pre-existing
 * "live" case here keeps meaning what it always meant.
 */
function deps(isAlive: boolean, host = THIS_HOST, ppid = 1000): ReconcileLaunchDeps {
  return {
    isPidAlive: () => isAlive,
    hostname: () => host,
    getPpid: () => (isAlive ? ppid : null)
  }
}

describe('reconcileLaunch (O3) — no prior launch', () => {
  it('an absent record is nothing to reconcile — dispatch fresh', () => {
    const out = reconcileLaunch({ status: 'absent' }, { requireContinuity: true }, deps(false))
    expect(out.kind).toBe('none')
  })

  it('a corrupt record with continuity required pauses explicitly — never a silent fresh start', () => {
    const out = reconcileLaunch({ status: 'corrupt', reason: 'torn write' }, { requireContinuity: true }, deps(false))
    expect(out.kind).toBe('pause')
    if (out.kind === 'pause') expect(out.detail).toContain('corrupt')
  })

  it('a corrupt record with continuity NOT required is just nothing to reconcile', () => {
    const out = reconcileLaunch({ status: 'corrupt', reason: 'torn' }, { requireContinuity: false }, deps(false))
    expect(out.kind).toBe('none')
  })
})

describe('reconcileLaunch (O3) — a live launch is found by identity', () => {
  it('crash between spawn and session binding: the child pid is still alive on this host, so the launch is LIVE — found by identity, never spawned again', () => {
    // The exact fault: the driver died after spawn wrote the child pid but
    // before any session id was bound (resumeId null, status still launched).
    // Recovery must find the still-live child rather than start a duplicate.
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'launched', resumeId: null, boundAt: null, finishedAt: null, childPid: 2000 })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(true))
    expect(out.kind).toBe('live')
    if (out.kind === 'live') expect(out.record.childPid).toBe(2000)
  })

  it('a launch recorded on a DIFFERENT host is never treated as live — its pid cannot be probed here', () => {
    const parsed: ParsedLaunch = { status: 'ok', record: record({ status: 'launched', resumeId: null }) }
    // isPidAlive would say true, but the record's host is not ours.
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(true, 'some-other-host'))
    expect(out.kind).not.toBe('live')
  })

  it('a null child pid (a launch that never spawned) is never live', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'interrupted', childPid: null, resumeId: 'sess-1' })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(true))
    expect(out.kind).not.toBe('live')
  })

  it('a live pid with a live recorded parent still returns live — no regression on the duplicate-worker guard', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'launched', resumeId: null, dispatcherPid: 1000, childPid: 2000 })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(true, THIS_HOST, 1000))
    expect(out.kind).toBe('live')
  })
})

describe('reconcileLaunch (O2, Issue #605) — an orphaned child is a takeover, never live', () => {
  it('a live pid whose PPID is 1 (reparented to init) never reads live — the driver that spawned it is gone', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'launched', dispatcherPid: 1000, childPid: 2000, resumeId: 'sess-mid' })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(true, THIS_HOST, 1))
    expect(out.kind).not.toBe('live')
    // Continuity was required and a session was already bound before the
    // driver died — the orphan is a TAKEOVER (resume that exact session),
    // never a block and never a silent fresh start.
    expect(out.kind).toBe('resume')
    if (out.kind === 'resume') expect(out.resumeId).toBe('sess-mid')
  })

  it('`classifyChildLiveness` names the orphan case directly, for the recovery wrapper to reap', () => {
    const rec = record({ status: 'launched', dispatcherPid: 1000, childPid: 2000 })
    const liveness = classifyChildLiveness(rec, deps(true, THIS_HOST, 1))
    expect(liveness).toBe('orphaned')
  })

  it('a reparented child whose OWN recorded dispatcher pid no longer answers is also orphaned, not live', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'launched', dispatcherPid: 1000, childPid: 2000, resumeId: null })
    }
    // The child still shows its old dispatcher as parent (ppid matches),
    // but that dispatcher pid itself no longer answers a liveness probe —
    // still never live.
    const out = reconcileLaunch(
      parsed,
      { requireContinuity: true },
      {
        isPidAlive: () => false,
        hostname: () => THIS_HOST,
        getPpid: () => 1000
      }
    )
    expect(out.kind).not.toBe('live')
  })
})

describe('reconcileLaunch (O3) — required continuity resumes the exact session', () => {
  it('a finished launch with a bound session resumes THAT exact session', () => {
    const parsed: ParsedLaunch = { status: 'ok', record: record({ status: 'completed', resumeId: 'sess-1' }) }
    const out = reconcileLaunch(parsed, { requireContinuity: true, artifactsPresent: true }, deps(false))
    expect(out.kind).toBe('resume')
    if (out.kind === 'resume') expect(out.resumeId).toBe('sess-1')
  })

  it('an INTERRUPTED launch whose session was bound before the interruption still resumes that exact session (O1 ↔ O3)', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'interrupted', failureReason: 'timeout', resumeId: 'sess-mid' })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(false))
    expect(out.kind).toBe('resume')
    if (out.kind === 'resume') expect(out.resumeId).toBe('sess-mid')
  })
})

describe('reconcileLaunch (O3) — an unavailable session pauses explicitly', () => {
  it('expired/gone session: an interrupted launch whose session was never bound cannot be resumed — pause explicitly', () => {
    // The honest "there is no session to resume" case — a fresh session would
    // silently lose the worker's continuity, so recovery pauses instead.
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'interrupted', failureReason: 'crash', resumeId: null, boundAt: null })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(false))
    expect(out.kind).toBe('pause')
    if (out.kind === 'pause') {
      expect(out.reason).toBe('infrastructure')
      expect(out.detail).toContain('cannot resume the exact session')
    }
  })
})

describe('reconcileLaunch (O3) — a reviewer is never resumed for continuity', () => {
  it('with continuity NOT required, a finished launch is finished — never a resume, even with a session on record', () => {
    const parsed: ParsedLaunch = { status: 'ok', record: record({ status: 'completed', resumeId: 'sess-1' }) }
    const out = reconcileLaunch(parsed, { requireContinuity: false, artifactsPresent: true }, deps(false))
    expect(out.kind).toBe('finished')
    if (out.kind === 'finished') expect(out.outcome.status).toBe('completed')
  })

  it('a finished launch with no artifacts is classified incomplete by the normalizer, exit code notwithstanding', () => {
    const parsed: ParsedLaunch = { status: 'ok', record: record({ status: 'completed', resumeId: 'sess-1' }) }
    const out = reconcileLaunch(parsed, { requireContinuity: false, artifactsPresent: false }, deps(false))
    expect(out.kind).toBe('finished')
    if (out.kind === 'finished') expect(out.outcome.status).toBe('incomplete')
  })
})
