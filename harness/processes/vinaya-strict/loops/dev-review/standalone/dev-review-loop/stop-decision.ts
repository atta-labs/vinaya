/**
 * The one decision function every loop stop goes through.
 *
 * A stop is an event the controller meets: the Developer reported its turn
 * blocked or asked for a ruling, a reviewer reported a blocker, or the round
 * ended on a driver error. `decideStop` takes that event, typed, and returns
 * exactly one decision — retry, wait, rerun, dispatch fresh, accept, or pause
 * with a named reason. It is pure: it reads no clock, file, process or forge,
 * so the caller resolves every fact into the event and the same event always
 * yields the same decision.
 *
 * Every event with no rule of its own decides the pause the runner produced
 * before this function existed, with the same reason and detail. A rule that
 * is not a pause is bounded: it carries the attempts or the time it may
 * spend, and the event that reports that bound spent decides today's pause.
 */

import type { PauseReason } from '../../../../tools/dev-review-policy/types'
import {
  DispatchSandboxRefused,
  DispatchSignInRefused,
  DispatchUsageLimit,
  isGitHubConnectionFailure,
  isGitHubRateLimitError
} from './round-assess.js'

/** Which runner meets the stop — the original loop or the Atta Engine runner. */
export type StopRunner = 'loop' | 'engine'

/** What a round-ending driver error is, decided once by the existing classifiers. */
export type DriverErrorClass =
  | 'forge_connection'
  | 'rate_limit'
  | 'usage_limit'
  | 'sign_in_refused'
  | 'sandbox_refused'
  | 'missing_source'
  | 'other'

export type StopEvent =
  | {
      kind: 'developer_blocked'
      /** One of the Developer's typed blocker kinds (`BLOCKER_KINDS`). */
      blockerKind: string
      blockerDetail: string
      summary: string
    }
  | {
      kind: 'developer_needs_ruling'
      question: string
      decisions: readonly string[]
      summary: string
    }
  | {
      kind: 'reviewer_blocker'
      /** The reviewer's blocker kind. */
      blockerKind: string
      detail: string
    }
  | {
      kind: 'driver_error'
      runner: StopRunner
      errorClass: DriverErrorClass
      message: string
      round: number
      /**
       * The detail the runner narrates itself for a class whose text depends
       * on state only it holds (a usage limit's reset, a rate limit's waits).
       * Absent, the pause carries the plain uncaught-error detail.
       */
      narration?: string
      /** How many retries this error's rule has already spent. */
      attempts?: number
    }
  | {
      /**
       * An earlier Developer launch bound no vendor session. `ended` is the
       * caller's resolved fact: no process of that launch is left that a fresh
       * session could race — its process is gone, or its recorded dispatcher
       * is the controller deciding now.
       */
      kind: 'unbound_launch'
      attempt: number
      ended: boolean
    }
  | {
      /**
       * Required CI on the task's head read red. Every field is the caller's
       * resolved forge fact, never an agent's judgment: the check names failing
       * on the head, the heads already rerun, and the parent's own current
       * state. `parentFailing` is `null` when the parent's checks could not be
       * read, which never decides a wait. `parentWaitedMs` is the wait this
       * red has already spent on the parent.
       */
      kind: 'ci_red'
      runner: StopRunner
      head: string
      headFailing: readonly string[]
      rerunHeads: readonly string[]
      parentFailing: readonly string[] | null
      parentWaitedMs: number
    }

/** The bound a non-pause decision may spend. */
export type StopBound =
  | { kind: 'attempts'; used: number; max: number }
  /** Documented exception: the original loop's wait for the GitHub connection has no time limit by design. */
  | { kind: 'unbounded' }
  /** A wait that has spent `usedMs` of the fixed `maxMs` it may spend. */
  | { kind: 'time'; usedMs: number; maxMs: number }

export type StopDecision =
  | { type: 'retry'; waitMs: number; bound: StopBound }
  | { type: 'wait'; bound: StopBound; spendsRetry: false; asksRuling: false }
  | { type: 'rerun'; bound: StopBound }
  | { type: 'dispatch_fresh'; bound: StopBound }
  /** The red is the task's own failure: the Developer's next turn takes it, as before this row existed. */
  | { type: 'send_back_to_developer' }
  | { type: 'accept' }
  | { type: 'pause'; reason: PauseReason; detail: string }

/** The Atta Engine runner retries a forge connection failure after this fixed wait … */
export const ENGINE_FORGE_RETRY_WAIT_MS = 30_000
/** … at most this many times: a total bound of three minutes of waiting. */
export const ENGINE_FORGE_RETRY_MAX_ATTEMPTS = 6

/** Red CI that every failing check shares with the parent waits this long in all for the parent to turn green … */
export const CI_PARENT_WAIT_MAX_MS = 90 * 60_000
/** … re-reading the parent after each of these fixed intervals. */
export const CI_PARENT_WAIT_POLL_MS = 60_000

/** The pause a parent that stayed red for the whole fixed wait decides. */
export function parentRedPauseDetail(failing: readonly string[]): string {
  return (
    `required CI is red on the task's head only because the default branch's own head is red (${failing.join(', ')}); ` +
    `it stayed red for the whole ${CI_PARENT_WAIT_MAX_MS / 60_000}-minute wait — the Principal decides`
  )
}

/**
 * The two CI rows. A head whose every failing check also fails on the
 * parent's current head waits for the parent (bounded, then pauses); any other
 * red reruns once per head, and a red head already rerun is a real failure for
 * the Developer. A head with no named failing check is never matched to the
 * parent.
 */
function decideCiRed(event: Extract<StopEvent, { kind: 'ci_red' }>): StopDecision {
  const parent = event.parentFailing
  const sharedWithParent =
    parent !== null && event.headFailing.length > 0 && event.headFailing.every((name) => parent.includes(name))
  if (sharedWithParent) {
    if (event.parentWaitedMs < CI_PARENT_WAIT_MAX_MS)
      return {
        type: 'wait',
        bound: { kind: 'time', usedMs: event.parentWaitedMs, maxMs: CI_PARENT_WAIT_MAX_MS },
        spendsRetry: false,
        asksRuling: false
      }
    return { type: 'pause', reason: 'infrastructure', detail: parentRedPauseDetail(event.headFailing) }
  }
  return event.rerunHeads.includes(event.head)
    ? { type: 'send_back_to_developer' }
    : { type: 'rerun', bound: { kind: 'attempts', used: 1, max: 1 } }
}

/** The detail of the pause an uncaught error ends a round with, unchanged from before this function. */
export function uncaughtErrorDetail(round: number, message: string): string {
  return `an uncaught error ended round ${round}'s own processing: ${message}`
}

/** The pause a Developer's `blocked` turn decides — one text, for every blocker kind. */
export function developerBlockedDetail(event: Extract<StopEvent, { kind: 'developer_blocked' }>): string {
  return `the Developer reported the task blocked (${event.blockerKind}): ${event.blockerDetail} — ${event.summary}`
}

/** The pause a Developer's `needs_ruling` turn decides. */
export function developerNeedsRulingDetail(event: Extract<StopEvent, { kind: 'developer_needs_ruling' }>): string {
  return `the Developer asks for a ruling: ${event.question} (decisions: ${event.decisions.join(', ')}) — ${event.summary}`
}

/**
 * The class of one round-ending error, from the loop's existing classifiers
 * alone — `isGitHubConnectionFailure` is the only matcher for an unreachable
 * forge or a timeout. A missing-source refusal is the caller's own type, so
 * it names it through `knownClass`.
 */
export function classifyDriverError(err: unknown): DriverErrorClass {
  if (err instanceof DispatchSignInRefused) return 'sign_in_refused'
  if (err instanceof DispatchUsageLimit) return 'usage_limit'
  if (err instanceof DispatchSandboxRefused) return 'sandbox_refused'
  // The connection check comes first, as the original loop's round loop always checked it.
  if (isGitHubConnectionFailure(err)) return 'forge_connection'
  if (isGitHubRateLimitError(err)) return 'rate_limit'
  return 'other'
}

/** The pause a driver error ends a round with when no rule resolves it — today's row for every class. */
export function pauseForDriverError(
  event: Extract<StopEvent, { kind: 'driver_error' }>
): Extract<StopDecision, { type: 'pause' }> {
  const reason: PauseReason =
    event.errorClass === 'sandbox_refused'
      ? 'sandbox_refused'
      : event.errorClass === 'missing_source'
        ? 'missing_source'
        : 'infrastructure'
  const narrated = event.errorClass !== 'other' && event.errorClass !== 'forge_connection'
  return {
    type: 'pause',
    reason,
    detail:
      narrated && event.narration !== undefined ? event.narration : uncaughtErrorDetail(event.round, event.message)
  }
}

/** The pause an unbound earlier launch whose process may still run decides — today's text. */
export function unboundLaunchPauseDetail(attempt: number): string {
  return (
    `the developer's prior launch (attempt ${attempt}) bound no vendor session and its process may still ` +
    'be running — refusing to start a second worker beside it'
  )
}

export function decideStop(event: StopEvent): StopDecision {
  switch (event.kind) {
    case 'unbound_launch':
      // An ended launch left no session and no turn state to lose: one fresh session replaces it.
      return event.ended
        ? { type: 'dispatch_fresh', bound: { kind: 'attempts', used: 1, max: 1 } }
        : { type: 'pause', reason: 'infrastructure', detail: unboundLaunchPauseDetail(event.attempt) }
    case 'ci_red':
      return decideCiRed(event)
    case 'developer_blocked':
      return { type: 'pause', reason: 'escalation', detail: developerBlockedDetail(event) }
    case 'developer_needs_ruling':
      return { type: 'pause', reason: 'escalation', detail: developerNeedsRulingDetail(event) }
    case 'reviewer_blocker':
      return { type: 'pause', reason: 'escalation', detail: event.detail }
    case 'driver_error': {
      if (event.errorClass === 'forge_connection') {
        // The original loop waits for the connection without limit, spending no retry and asking no ruling.
        if (event.runner === 'loop') {
          return { type: 'wait', bound: { kind: 'unbounded' }, spendsRetry: false, asksRuling: false }
        }
        const used = event.attempts ?? 0
        if (used < ENGINE_FORGE_RETRY_MAX_ATTEMPTS) {
          return {
            type: 'retry',
            waitMs: ENGINE_FORGE_RETRY_WAIT_MS,
            bound: { kind: 'attempts', used: used + 1, max: ENGINE_FORGE_RETRY_MAX_ATTEMPTS }
          }
        }
      }
      return pauseForDriverError(event)
    }
  }
}
