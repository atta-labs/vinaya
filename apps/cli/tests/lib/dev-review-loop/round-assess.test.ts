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
import { budgetMarkerStep } from '../../../src/lib/artifacts'
import {
  assertDispatchOrEscalate,
  assessRateLimitedRed,
  isRateLimitedJobLog,
  jobRateLimitReset,
  parseBudgetMarker,
  RateLimitWaitsSpent,
  rateLimitResetFromDetail,
  DeveloperDispatchHistory,
  DevReviewLoopResumeError,
  DispatchSandboxRefused,
  DispatchSignInRefused,
  GitHubKeptAnswering,
  isGitHubConnectionFailure,
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

describe('assertDispatchOrEscalate — a sandbox capability refusal is typed from the probe result', () => {
  const refusal = { agent: 'claude' as const, error: 'apply-seccomp: Permission denied' }

  it('throws DispatchSandboxRefused for a refused handle carrying the probe result, on a fresh round and a resumed one alike', async () => {
    for (const isResume of [false, true]) {
      const handle: DispatchHandle = { ...failedHandle('refused'), sandboxProbeRefusal: refusal }
      const promise = assertDispatchOrEscalate(handle, 'claude', isResume, true, 'the developer', true)
      await expect(promise).rejects.toBeInstanceOf(DispatchSandboxRefused)
      await promise.catch((err: Error) => expect(err.message).toContain(refusal.error))
    }
  })

  it('a refused handle with no probe result keeps the generic dispatch failure', async () => {
    const promise = assertDispatchOrEscalate(failedHandle('refused'), 'claude', false, false, 'the developer')
    await expect(promise).rejects.not.toBeInstanceOf(DispatchSandboxRefused)
    await promise.catch((err: Error) => expect(err.message).toContain('dispatching claude failed (refused)'))
  })

  it('spends no infrastructure retry', () => {
    expect(spendsInfrastructureRetry(new DispatchSandboxRefused(refusal, 'the developer'))).toBe(false)
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

  it('the pause detail records the reset it last read after its prefix, and only it reads back', () => {
    const detail = `${rateLimitPauseDetail(2, 1_760_000_500)} (round 3: boom at epoch 99.)`
    expect(isRateLimitPauseDetail(detail)).toBe(true)
    expect(detail.startsWith('GitHub rate limit:')).toBe(true)
    expect(rateLimitResetFromDetail(detail)).toBe(1_760_000_500)
    expect(rateLimitResetFromDetail(rateLimitPauseDetail(2))).toBeNull()
    expect(rateLimitResetFromDetail('Usage limit: the reset it last read is epoch 5.')).toBeNull()
  })

  it('a spent wait budget for a red check reads as a GitHub rate limit that spends no retry', () => {
    const err = new RateLimitWaitsSpent(1_760_000_500, 'the failed checks on head abc')
    expect(isGitHubRateLimitError(err)).toBe(true)
    expect(spendsInfrastructureRetry(err)).toBe(false)
    expect(err.resetEpochSeconds).toBe(1_760_000_500)
  })
})

/** A job log tail as GitHub prints it: every line timestamped. */
const tail = (...lines: string[]) => lines.map((line) => `2026-10-18T10:00:00.0000000Z ${line}`).join('\n')
const marker = (exhausted: 'core' | 'graphql' | 'none', coreReset = 1_760_000_100, graphqlReset = 1_760_000_900) =>
  `vinaya-budget: exhausted=${exhausted} core_remaining=${exhausted === 'core' ? 0 : 4000} core_reset=${coreReset} graphql_remaining=${exhausted === 'graphql' ? 0 : 4000} graphql_reset=${graphqlReset}`

describe('the budget marker a failed CI job prints', () => {
  it('never matches the rate-limit pattern, whatever budget it names', () => {
    for (const exhausted of ['core', 'graphql', 'none'] as const) {
      expect(isGitHubRateLimitError(new Error(marker(exhausted)))).toBe(false)
      expect(marker(exhausted).length).toBeLessThanOrEqual(200)
    }
    // The generated step's own text, which a job log echoes, matches neither the wording nor the marker.
    expect(isGitHubRateLimitError(new Error(budgetMarkerStep()))).toBe(false)
    expect(parseBudgetMarker(budgetMarkerStep())).toBeNull()
  })

  it('the generated step runs only on failure, with the job token, and never fails the job again', () => {
    const step = budgetMarkerStep()
    expect(step).toContain('if: failure()')
    expect(step).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(step).toContain('gh api rate_limit')
    expect(step.trimEnd().endsWith('|| true')).toBe(true)
  })

  it('reads the last marker line, prefixed by a timestamp', () => {
    const log = tail('error: boom', marker('none'), marker('core', 1_760_000_222))
    expect(parseBudgetMarker(log)).toEqual({
      exhausted: 'core',
      core: { remaining: 0, reset: 1_760_000_222 },
      graphql: { remaining: 4000, reset: 1_760_000_900 }
    })
    expect(parseBudgetMarker(tail('error: boom'))).toBeNull()
    expect(parseBudgetMarker(null)).toBeNull()
  })

  it('a job is rate-limited by the wording, or by a marker naming a spent budget once the wording scrolled out', () => {
    expect(isRateLimitedJobLog(tail('gh: API rate limit already exceeded for installation ID 1'))).toBe(true)
    expect(isRateLimitedJobLog(tail('(fail) some test', marker('graphql')))).toBe(true)
    expect(isRateLimitedJobLog(tail('(fail) some test', marker('none')))).toBe(false)
    expect(isRateLimitedJobLog(null)).toBe(false)
  })

  it('the reset is the GraphQL budget when a line contains GraphQL’s wording, else the spent budget, else none', () => {
    expect(jobRateLimitReset(tail('GraphQL: API rate limit exceeded for installation ID 1', marker('core')))).toBe(
      1_760_000_900
    )
    expect(jobRateLimitReset(tail('(fail) x', marker('core')))).toBe(1_760_000_100)
    expect(jobRateLimitReset(tail('(fail) x', marker('graphql')))).toBe(1_760_000_900)
    expect(jobRateLimitReset(tail('secondary rate limit', marker('none')))).toBeNull()
    expect(jobRateLimitReset(tail('API rate limit exceeded'))).toBeNull()
  })
})

describe('assessRateLimitedRed — a red that is a rate limit and nothing else', () => {
  const aggregate = tail(
    'A required job did not succeed: failure',
    'vinaya-needs: a required job ended failure',
    marker('none')
  )

  it('every failed job rate-limited, plus an aggregate failing only on its needs, is a rate-limited red at the latest reset', () => {
    expect(
      assessRateLimitedRed([
        { logTail: tail('(fail) x', marker('core', 1_760_000_100)) },
        { logTail: tail('GraphQL: API rate limit exceeded', marker('none', 1, 1_760_000_700)) },
        { logTail: aggregate }
      ])
    ).toEqual({ resetEpochSeconds: 1_760_000_700 })
  })

  it('a rate-limited job with no marker line waits the fallback', () => {
    expect(assessRateLimitedRed([{ logTail: tail('API rate limit exceeded') }])).toEqual({ resetEpochSeconds: null })
  })

  it('any failed job that is not rate-limited makes it an ordinary red', () => {
    expect(
      assessRateLimitedRed([
        { logTail: tail('(fail) x', marker('core')) },
        { logTail: tail('(fail) y', marker('none')) }
      ])
    ).toBeNull()
    expect(assessRateLimitedRed([{ logTail: tail('(fail) x', marker('core')) }, { logTail: null }])).toBeNull()
  })

  it('an aggregate alone, or no failed job at all, is no rate-limited red', () => {
    expect(assessRateLimitedRed([{ logTail: aggregate }])).toBeNull()
    expect(assessRateLimitedRed([])).toBeNull()
  })

  it('the echoed needs script, with no result word, does not cover a failure', () => {
    expect(
      assessRateLimitedRed([
        { logTail: tail('(fail) x', marker('core')) },
        { logTail: tail('echo "vinaya-needs: a required job ended $result"', 'boom') }
      ])
    ).toBeNull()
  })
})

describe('isGitHubConnectionFailure — no response from GitHub, read from the error’s own cause', () => {
  const withStderr = (message: string, stderr: string) => Object.assign(new Error(message), { stderr })

  it('gh’s own report that it could not connect is one', () => {
    const err = new Error(
      'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'
    )
    expect(isGitHubConnectionFailure(err)).toBe(true)
    expect(spendsInfrastructureRetry(err)).toBe(false)
  })

  it('a transport error on a GitHub URL in captured stderr is one', () => {
    for (const cause of [
      'dial tcp 140.82.112.6:443: connect: connection refused',
      'dial tcp: lookup api.github.com: no such host',
      'net/http: TLS handshake timeout',
      'context deadline exceeded (Client.Timeout exceeded while awaiting headers)'
    ]) {
      const err = withStderr('Command failed: gh api graphql', `Post "https://api.github.com/graphql": ${cause}\n`)
      expect(isGitHubConnectionFailure(err)).toBe(true)
    }
  })

  it('git’s unable-to-access line for github.com is one', () => {
    const err = withStderr(
      'Command failed: git fetch origin',
      "fatal: unable to access 'https://github.com/atta-labs/vinaya.git/': Could not resolve host: github.com\n"
    )
    expect(isGitHubConnectionFailure(err)).toBe(true)
  })

  it('an SSH remote that cannot resolve or reach github.com is one', () => {
    for (const line of [
      'ssh: Could not resolve hostname github.com: Temporary failure in name resolution',
      'ssh: connect to host github.com port 22: Network is unreachable',
      'ssh: connect to host github.com port 22: Connection timed out'
    ]) {
      const err = withStderr(
        'Command failed: git ls-remote origin',
        `${line}\nfatal: Could not read from remote repository.`
      )
      expect(isGitHubConnectionFailure(err)).toBe(true)
      expect(spendsInfrastructureRetry(err)).toBe(false)
    }
    // A host other than GitHub, or an SSH refusal GitHub sent, is not one.
    expect(
      isGitHubConnectionFailure(
        withStderr('x', 'ssh: Could not resolve hostname gitlab.example: Name or service not known')
      )
    ).toBe(false)
    expect(isGitHubConnectionFailure(withStderr('x', 'git@github.com: Permission denied (publickey).'))).toBe(false)
  })

  it('a no-response system error code naming a GitHub host, on the error or its cause, is one', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), {
      code: 'ENOTFOUND',
      hostname: 'api.github.com'
    })
    expect(isGitHubConnectionFailure(new TypeError('fetch failed', { cause }))).toBe(true)
  })

  it('a response GitHub sent — a server error, a malformed body — is not one, and keeps its budget', () => {
    for (const err of [
      new Error('HTTP 502: Bad Gateway (https://api.github.com/graphql)'),
      new Error("invalid character '<' looking for beginning of value"),
      withStderr('Command failed: gh pr view', 'GraphQL: Could not resolve to a PullRequest with the number of 7.')
    ]) {
      expect(isGitHubConnectionFailure(err)).toBe(false)
      expect(spendsInfrastructureRetry(err)).toBe(true)
    }
  })

  it('a message that merely mentions a connection is not one: only a line’s structured cause counts', () => {
    expect(isGitHubConnectionFailure(new Error('the round ended: connection refused while reading github.com'))).toBe(
      false
    )
  })

  it('a connection failure to another host is not one', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', hostname: 'example.com' })
    expect(isGitHubConnectionFailure(new TypeError('fetch failed', { cause }))).toBe(false)
    const err = withStderr(
      'Command failed',
      'Get "https://example.com/doc": dial tcp: lookup example.com: no such host'
    )
    expect(isGitHubConnectionFailure(err)).toBe(false)
  })

  it('a step that kept failing while GitHub answered is not one, and spends the budget', () => {
    const err = new GitHubKeptAnswering(new Error('error connecting to api.github.com'))
    expect(isGitHubConnectionFailure(err)).toBe(false)
    expect(spendsInfrastructureRetry(err)).toBe(true)
  })
})
