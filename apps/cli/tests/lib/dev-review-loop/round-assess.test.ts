/**
 * Unit tests for `round-assess.ts`'s `parseConfidenceReply` — the developer's
 * `.vinaya-confidence` reply, parsed once, destructively, at the gate read.
 */

import { describe, expect, it } from 'bun:test'
import { CONFIDENCE_REASON_MAX_LENGTH } from '@attalabs/aeg-core'
import {
  assertDispatchOrEscalate,
  DeveloperDispatchHistory,
  DevReviewLoopResumeError,
  parseConfidenceReply
} from '../../../src/lib/dev-review-loop/round-assess'
import type { DispatchHandle } from '../../../src/lib/dispatch'

describe('parseConfidenceReply', () => {
  it('parses a well-formed line into a value and reason', () => {
    expect(parseConfidenceReply('CONFIDENCE: 90 — fixed the reported issue\n')).toEqual({
      value: 90,
      reason: 'fixed the reported issue'
    })
  })

  it('a missing line reads absent, never a guessed number', () => {
    expect(parseConfidenceReply('')).toBe('absent')
  })

  it('an out-of-range value reads absent', () => {
    expect(parseConfidenceReply('CONFIDENCE: 101 — too high\n')).toBe('absent')
  })

  it('a reason longer than the schema bound is truncated to it, never dropped or left to fail validation downstream', () => {
    const longReason = 'x'.repeat(CONFIDENCE_REASON_MAX_LENGTH + 50)
    const result = parseConfidenceReply(`CONFIDENCE: 80 — ${longReason}\n`)
    expect(result).not.toBe('absent')
    if (result === 'absent') throw new Error('unreachable')
    expect(result.reason).toHaveLength(CONFIDENCE_REASON_MAX_LENGTH)
    expect(result.reason).toBe(longReason.slice(0, CONFIDENCE_REASON_MAX_LENGTH))
  })

  it('a reason exactly at the bound is kept whole', () => {
    const exactReason = 'y'.repeat(CONFIDENCE_REASON_MAX_LENGTH)
    const result = parseConfidenceReply(`CONFIDENCE: 80 — ${exactReason}\n`)
    expect(result).not.toBe('absent')
    if (result === 'absent') throw new Error('unreachable')
    expect(result.reason).toBe(exactReason)
  })
})

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
