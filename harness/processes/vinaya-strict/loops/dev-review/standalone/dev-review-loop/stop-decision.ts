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

/** The bound a non-pause decision may spend. */
export type StopBound =
  | { kind: 'attempts'; used: number; max: number }
  /** Documented exception: the original loop's wait for the GitHub connection has no time limit by design. */
  | { kind: 'unbounded' }

export type StopDecision =
  | { type: 'retry'; waitMs: number; bound: StopBound }
  | { type: 'wait'; bound: StopBound; spendsRetry: false; asksRuling: false }
  | { type: 'rerun'; bound: StopBound }
  | { type: 'dispatch_fresh'; bound: StopBound }
  | { type: 'accept' }
  | { type: 'pause'; reason: PauseReason; detail: string }

/** The Atta Engine runner retries a forge connection failure after this fixed wait … */
export const ENGINE_FORGE_RETRY_WAIT_MS = 30_000
/** … at most this many times: a total bound of three minutes of waiting. */
export const ENGINE_FORGE_RETRY_MAX_ATTEMPTS = 6

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
  if (isGitHubRateLimitError(err)) return 'rate_limit'
  if (isGitHubConnectionFailure(err)) return 'forge_connection'
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

export function decideStop(event: StopEvent): StopDecision {
  switch (event.kind) {
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
