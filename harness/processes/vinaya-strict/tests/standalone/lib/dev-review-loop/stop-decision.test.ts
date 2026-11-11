import { describe, expect, test } from 'bun:test'

import {
  DispatchSandboxRefused,
  DispatchSignInRefused,
  DispatchUsageLimit
} from '../../../../loops/dev-review/standalone/dev-review-loop/round-assess'
import {
  CI_PARENT_WAIT_MAX_MS,
  classifyDriverError,
  decideStop,
  ENGINE_FORGE_RETRY_MAX_ATTEMPTS,
  ENGINE_FORGE_RETRY_WAIT_MS,
  pauseForDriverError,
  uncaughtErrorDetail,
  type DriverErrorClass,
  type StopEvent
} from '../../../../loops/dev-review/standalone/dev-review-loop/stop-decision'
import { BLOCKER_KINDS } from '../../../../executing/developer/developer-turn-result'

const timeout = (): Error =>
  Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', hostname: 'api.github.com' })

describe('decideStop — Developer turns', () => {
  for (const kind of BLOCKER_KINDS) {
    test(`a ${kind} blocker pauses for escalation with today's detail`, () => {
      expect(decideStop({ kind: 'developer_blocked', blockerKind: kind, blockerDetail: 'd', summary: 's' })).toEqual({
        type: 'pause',
        reason: 'escalation',
        detail: `the Developer reported the task blocked (${kind}): d — s`
      })
    })
  }

  test("a ruling request pauses for escalation with today's detail", () => {
    expect(decideStop({ kind: 'developer_needs_ruling', question: 'q?', decisions: ['a', 'b'], summary: 's' })).toEqual(
      { type: 'pause', reason: 'escalation', detail: 'the Developer asks for a ruling: q? (decisions: a, b) — s' }
    )
  })

  test('a reviewer blocker pauses for escalation with its own detail', () => {
    expect(decideStop({ kind: 'reviewer_blocker', blockerKind: 'tooling_unavailable', detail: 'x' })).toEqual({
      type: 'pause',
      reason: 'escalation',
      detail: 'x'
    })
  })
})

describe('decideStop — driver errors', () => {
  const base = { kind: 'driver_error', message: 'boom', round: 3 } as const
  const plain = uncaughtErrorDetail(3, 'boom')

  test('the detail of an uncaught error is unchanged', () => {
    expect(plain).toBe("an uncaught error ended round 3's own processing: boom")
  })

  const pauseRows: Array<[DriverErrorClass, 'infrastructure' | 'sandbox_refused' | 'missing_source', string]> = [
    ['other', 'infrastructure', plain],
    ['rate_limit', 'infrastructure', 'narrated'],
    ['usage_limit', 'infrastructure', 'narrated'],
    ['sign_in_refused', 'infrastructure', 'narrated'],
    ['sandbox_refused', 'sandbox_refused', 'narrated'],
    ['missing_source', 'missing_source', 'narrated']
  ]
  for (const runner of ['loop', 'engine'] as const) {
    for (const [errorClass, reason, detail] of pauseRows) {
      test(`${runner}: ${errorClass} pauses as '${reason}' (the runner's narration kept)`, () => {
        const narration = detail === 'narrated' ? { narration: 'narrated' } : {}
        expect(decideStop({ ...base, runner, errorClass, ...narration })).toEqual({ type: 'pause', reason, detail })
      })
    }
  }

  test('without a narration, a narrated class carries the plain uncaught-error detail', () => {
    expect(decideStop({ ...base, runner: 'engine', errorClass: 'rate_limit' })).toEqual({
      type: 'pause',
      reason: 'infrastructure',
      detail: plain
    })
  })

  test('the original loop waits for the connection without limit, spends no retry and asks no ruling', () => {
    for (const attempts of [undefined, 0, 1, 99]) {
      expect(
        decideStop({
          ...base,
          runner: 'loop',
          errorClass: 'forge_connection',
          ...(attempts === undefined ? {} : { attempts })
        })
      ).toEqual({ type: 'wait', bound: { kind: 'unbounded' }, spendsRetry: false, asksRuling: false })
    }
  })

  test('the Engine runner retries a forge connection failure after the fixed wait, within the fixed bound', () => {
    for (let used = 0; used < ENGINE_FORGE_RETRY_MAX_ATTEMPTS; used += 1) {
      expect(decideStop({ ...base, runner: 'engine', errorClass: 'forge_connection', attempts: used })).toEqual({
        type: 'retry',
        waitMs: ENGINE_FORGE_RETRY_WAIT_MS,
        bound: { kind: 'attempts', used: used + 1, max: ENGINE_FORGE_RETRY_MAX_ATTEMPTS }
      })
    }
  })

  test('the bound is a few minutes in total', () => {
    expect(ENGINE_FORGE_RETRY_WAIT_MS * ENGINE_FORGE_RETRY_MAX_ATTEMPTS).toBeLessThanOrEqual(5 * 60_000)
    expect(ENGINE_FORGE_RETRY_WAIT_MS * ENGINE_FORGE_RETRY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2 * 60_000)
  })

  test('once the bound is spent the Engine runner pauses as it did, for the infrastructure', () => {
    for (const attempts of [ENGINE_FORGE_RETRY_MAX_ATTEMPTS, ENGINE_FORGE_RETRY_MAX_ATTEMPTS + 5]) {
      expect(decideStop({ ...base, runner: 'engine', errorClass: 'forge_connection', attempts })).toEqual({
        type: 'pause',
        reason: 'infrastructure',
        detail: plain
      })
    }
  })

  test('the same event always yields the same decision', () => {
    const event: StopEvent = { ...base, runner: 'engine', errorClass: 'forge_connection', attempts: 2 }
    expect(decideStop(event)).toEqual(decideStop({ ...event }))
  })

  test('pauseForDriverError is the default row for a connection failure', () => {
    expect(pauseForDriverError({ ...base, runner: 'loop', errorClass: 'forge_connection' }).detail).toBe(plain)
  })
})

describe('decideStop — an earlier Developer launch that bound no session', () => {
  test('an ended launch dispatches one fresh session, bounded to a single attempt', () => {
    expect(decideStop({ kind: 'unbound_launch', attempt: 2, ended: true })).toEqual({
      type: 'dispatch_fresh',
      bound: { kind: 'attempts', used: 1, max: 1 }
    })
  })

  test("a launch whose process may still run keeps today's pause", () => {
    expect(decideStop({ kind: 'unbound_launch', attempt: 2, ended: false })).toEqual({
      type: 'pause',
      reason: 'infrastructure',
      detail:
        "the developer's prior launch (attempt 2) bound no vendor session and its process may still be running — refusing to start a second worker beside it"
    })
  })
})

describe('classifyDriverError', () => {
  test('uses the existing classifiers', () => {
    expect(classifyDriverError(timeout())).toBe('forge_connection')
    expect(classifyDriverError(new Error('API rate limit already exceeded for user'))).toBe('rate_limit')
    expect(classifyDriverError(new Error('something else'))).toBe('other')
    expect(classifyDriverError('a string')).toBe('other')
    expect(classifyDriverError(new DispatchSignInRefused('claude' as never, 'task'))).toBe('sign_in_refused')
    expect(classifyDriverError(new DispatchSandboxRefused({ agent: 'claude', error: 'e' } as never, 'task'))).toBe(
      'sandbox_refused'
    )
    expect(classifyDriverError(new DispatchUsageLimit({ agent: 'claude', message: 'm' } as never, 'task'))).toBe(
      'usage_limit'
    )
  })
})

describe('decideStop — required CI red', () => {
  const red = (over: Partial<Extract<StopEvent, { kind: 'ci_red' }>> = {}): StopEvent => ({
    kind: 'ci_red',
    runner: 'loop',
    head: 'h1',
    headFailing: ['unit'],
    rerunHeads: [],
    parentFailing: [],
    parentConclusion: 'green',
    parentWaitedMs: 0,
    ...over
  })

  for (const runner of ['loop', 'engine'] as const) {
    test(`${runner}: the first red of a head reruns once`, () => {
      expect(decideStop(red({ runner }))).toEqual({ type: 'rerun', bound: { kind: 'attempts', used: 1, max: 1 } })
    })

    test(`${runner}: a head already rerun is a real failure for the Developer`, () => {
      expect(decideStop(red({ runner, rerunHeads: ['h1'] }))).toEqual({ type: 'send_back_to_developer' })
    })

    test(`${runner}: a rerun of another head does not spend this head's rerun`, () => {
      expect(decideStop(red({ runner, rerunHeads: ['h0'] })).type).toBe('rerun')
    })

    test(`${runner}: every failing check also failing on the parent waits, within the fixed bound`, () => {
      expect(decideStop(red({ runner, parentFailing: ['unit', 'lint'], parentWaitedMs: 60_000 }))).toEqual({
        type: 'wait',
        bound: { kind: 'time', usedMs: 60_000, maxMs: CI_PARENT_WAIT_MAX_MS },
        spendsRetry: false,
        asksRuling: false
      })
    })

    test(`${runner}: the parent red for the whole bound pauses for the Principal`, () => {
      const decided = decideStop(red({ runner, parentFailing: ['unit'], parentWaitedMs: CI_PARENT_WAIT_MAX_MS }))
      expect(decided.type).toBe('pause')
      expect(decided).toMatchObject({ reason: 'infrastructure' })
    })
  }

  test('a check failing only on the head is a branch failure, never a parent wait', () => {
    expect(decideStop(red({ headFailing: ['unit', 'lint'], parentFailing: ['unit'] })).type).toBe('rerun')
    expect(decideStop(red({ headFailing: ['unit'], parentFailing: ['lint'], rerunHeads: ['h1'] }))).toEqual({
      type: 'send_back_to_developer'
    })
  })

  test('an unreadable parent or a head with no named failing check never waits', () => {
    expect(decideStop(red({ parentFailing: null })).type).toBe('rerun')
    expect(decideStop(red({ headFailing: [], parentFailing: ['unit'] })).type).toBe('rerun')
  })

  test('the parent turning green after a wait reruns the head once, even when its first-red rerun is spent', () => {
    expect(decideStop(red({ parentFailing: [], parentWaitedMs: 120_000 })).type).toBe('rerun')
    expect(decideStop(red({ parentFailing: [], parentWaitedMs: 120_000, rerunHeads: ['h1'] })).type).toBe('rerun')
  })

  test('a pending, red or unread parent is never green: a begun wait goes on, bounded', () => {
    for (const parentConclusion of ['pending', 'red', null] as const) {
      expect(decideStop(red({ parentFailing: [], parentConclusion, parentWaitedMs: 60_000 })).type).toBe('wait')
      expect(decideStop(red({ parentFailing: [], parentConclusion, parentWaitedMs: CI_PARENT_WAIT_MAX_MS })).type).toBe(
        'pause'
      )
    }
  })

  test('a pending parent before any wait began, naming no shared failure, is not waited on', () => {
    expect(decideStop(red({ parentFailing: [], parentConclusion: 'pending' })).type).toBe('rerun')
  })
})
