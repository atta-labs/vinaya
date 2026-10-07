/**
 * Unit tests for `round-assess.ts`'s round-assessment glue — dispatch/resume
 * escalation, rate-limit waits and the infrastructure-retry budget.
 *
 * This file is also this directory's own precedent for where a dev-review-loop
 * contract test lives: `dev-review-engine-state-contract.test.ts`, beside it,
 * is the target Atta-Engine state model's contract test, the same way this
 * file is the standalone loop's.
 */

import { describe, expect, it } from 'bun:test'
import {
  assertDispatchOrEscalate,
  DeveloperDispatchHistory,
  DevReviewLoopResumeError,
  DispatchSignInRefused,
  isGitHubRateLimitError,
  isRateLimitPauseDetail,
  RATE_LIMIT_FALLBACK_WAIT_MS,
  rateLimitPauseDetail,
  rateLimitWaitMs,
  spendsInfrastructureRetry
} from '../../../src/lib/dev-review-loop/round-assess'
import type { DispatchHandle } from '../../../src/lib/dispatch'

function failedHandle(failureReason: DispatchHandle['failureReason']): DispatchHandle {
  return { exitCode: 1, durationMs: 1, usage: null, resumeId: null, timedOut: false, failureReason }
}

describe('assertDispatchOrEscalate — resume-failure crash message (ruling 986-1, Issue #985)', () => {
  it('a resume failing after an EARLIER round succeeded says "after succeeding last round"', async () => {
    const promise = assertDispatchOrEscalate(failedHandle('crash'), 'claude', true, true, 'the developer', true)
    await expect(promise).rejects.toBeInstanceOf(DevReviewLoopResumeError)
    await promise.catch((err: Error) => {
      expect(err.message).toContain('after succeeding last round')
      expect(err.message).not.toContain("session's first resume")
    })
  })

  it("a same-round resume failing after only this round's fresh dispatch succeeded never claims a last round", async () => {
    // Round 1: the fresh dispatch succeeded, then the same round's resume to
    // push/open the PR failed — there is no previous round to have succeeded.
    const promise = assertDispatchOrEscalate(failedHandle('crash'), 'claude', true, true, 'the developer', false)
    await expect(promise).rejects.toBeInstanceOf(DevReviewLoopResumeError)
    await promise.catch((err: Error) => {
      expect(err.message).toContain("session's first resume")
      expect(err.message).not.toContain('after succeeding last round')
    })
  })

  it('the default (reviewer call sites, never a resume) behaves as a not-earlier-round resume', async () => {
    const promise = assertDispatchOrEscalate(failedHandle('crash'), 'claude', true, true, 'the developer')
    await expect(promise).rejects.toBeInstanceOf(DevReviewLoopResumeError)
    await promise.catch((err: Error) => {
      expect(err.message).toContain("session's first resume")
    })
  })

  it('a clean handle (no failureReason) never throws', async () => {
    const handle: DispatchHandle = { exitCode: 0, durationMs: 1, usage: null, resumeId: 'abc', timedOut: false }
    await expect(
      assertDispatchOrEscalate(handle, 'claude', true, true, 'the developer', false)
    ).resolves.toBeUndefined()
  })
})

describe('DeveloperDispatchHistory — latches the FIRST success round (round-3 review MAJOR, ruling 986-1)', () => {
  it('reports no success and no earlier-round success before anything has run', () => {
    const h = new DeveloperDispatchHistory()
    expect(h.hasSucceeded).toBe(false)
    expect(h.succeededBeforeRound(1)).toBe(false)
  })

  it("round 1's own same-round resume failure never claims an earlier round succeeded", () => {
    const h = new DeveloperDispatchHistory()
    // Round 1: the fresh dispatch succeeds...
    h.recordSuccess(1)
    expect(h.hasSucceeded).toBe(true)
    // ...then round 1's own push/open resume fails — no earlier round exists.
    expect(h.succeededBeforeRound(1)).toBe(false)
  })

  it('the exact F1 ordering: round-2 main resume success must NOT erase that round 1 succeeded', () => {
    const h = new DeveloperDispatchHistory()
    // Round 1 fresh dispatch succeeds.
    h.recordSuccess(1)
    // Round 2's main resume succeeds — a most-recent-success tracker would move
    // to round 2 here; the latch must keep the first-success round at 1.
    h.recordSuccess(2)
    // Round 2's same-round COMMIT_AND_PUSH resume then fails: round 1 genuinely
    // succeeded, so this is a previous-round-succeeded true positive, never a
    // first-resume failure.
    expect(h.succeededBeforeRound(2)).toBe(true)
  })

  it('a round-2 main resume failing after only round 1 succeeded is an earlier-round success', () => {
    const h = new DeveloperDispatchHistory()
    h.recordSuccess(1)
    expect(h.succeededBeforeRound(2)).toBe(true)
  })
})

describe('GitHub rate-limit classification', () => {
  it('matches the primary and secondary rate-limit wording, in the message or the stderr', () => {
    expect(isGitHubRateLimitError(new Error('gh: API rate limit already exceeded for user ID 1. (HTTP 403)'))).toBe(
      true
    )
    expect(isGitHubRateLimitError(new Error('You have exceeded a secondary rate limit'))).toBe(true)
    const withStderr = Object.assign(new Error('Command failed: gh api'), { stderr: 'API rate limit exceeded' })
    expect(isGitHubRateLimitError(withStderr)).toBe(true)
  })

  it('never matches an error that merely mentions GitHub, or a non-error', () => {
    expect(isGitHubRateLimitError(new Error('GitHub returned 500'))).toBe(false)
    expect(isGitHubRateLimitError(new Error('gh: Not Found (HTTP 404)'))).toBe(false)
    expect(isGitHubRateLimitError('API rate limit exceeded')).toBe(false)
  })

  it('spends no infrastructure retry, like a sign-in refusal; every other error does', () => {
    expect(spendsInfrastructureRetry(new Error('API rate limit exceeded'))).toBe(false)
    expect(spendsInfrastructureRetry(new DispatchSignInRefused('claude', 'the developer'))).toBe(false)
    expect(spendsInfrastructureRetry(new Error('boom'))).toBe(true)
  })

  it('waits until the reported reset plus slack, else the fixed fallback', () => {
    expect(rateLimitWaitMs(1_000 + 60, 1_000_000)).toBe(60_000 + 5_000)
    expect(rateLimitWaitMs(null, 1_000_000)).toBe(RATE_LIMIT_FALLBACK_WAIT_MS)
    expect(rateLimitWaitMs(900, 1_000_000)).toBe(RATE_LIMIT_FALLBACK_WAIT_MS)
  })

  it('the pause detail says how many waits really ran and is recognised by the comment renderers', () => {
    expect(rateLimitPauseDetail(0)).toContain('did not wait')
    expect(rateLimitPauseDetail(0)).not.toContain('waited')
    expect(rateLimitPauseDetail(1)).toContain('waited for the limit to reset once')
    expect(rateLimitPauseDetail(2)).toContain('reset 2 times')
    expect(isRateLimitPauseDetail(rateLimitPauseDetail(2))).toBe(true)
    expect(rateLimitPauseDetail(2)).toContain('No ruling is needed')
    expect(isRateLimitPauseDetail('an uncaught error ended round 1')).toBe(false)
  })
})
