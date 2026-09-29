/**
 * Scripted fakes for the developer, both reviewers, and CI — zero network,
 * zero subprocesses. Each fake produces a
 * typed `Observations`/`VerdictObservation` value exactly as the real driver
 * would once it has decoded the real actor's output; nothing here reaches a
 * process, a file, or the forge.
 */

import { assessRound } from './assess-round'
import type {
  Confidence,
  Decision,
  DevReviewLoopEventInput,
  LoopState,
  Observations,
  RoundStats,
  TaskClock,
  VerdictObservation
} from './types'

export function fakeStats(round: number, overrides: Partial<RoundStats> = {}): RoundStats {
  return {
    baseHead: `base${round}`,
    head: `head${round}`,
    filesChanged: 1,
    insertions: 1,
    deletions: 1,
    wallMs: 1000,
    ...overrides
  }
}

/**
 * The CI fake: a round's mechanical-gate result, optionally carrying the
 * developer's confidence and — for a red gate — the mechanical failure the
 * driver observed, verbatim, exactly as the real one reports it.
 */
export function fakeGate(
  round: number,
  green: boolean,
  opts: { confidence?: Confidence; stats?: Partial<RoundStats>; failure?: string } = {}
): Observations {
  return {
    kind: 'gate',
    round,
    green,
    ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
    ...(opts.failure !== undefined ? { failure: opts.failure } : {}),
    stats: fakeStats(round, opts.stats)
  }
}

/** The two-reviewer fake: bundles both verdicts into one round observation. */
export function fakeVerdicts(round: number, verdicts: VerdictObservation[]): Observations {
  return { kind: 'verdicts', round, verdicts }
}

/** A clean reviewer/security verdict: approves, every named objective met, no findings. */
export function cleanVerdict(role: 'reviewer' | 'security', objectiveIds: string[] = []): VerdictObservation {
  return {
    role,
    verdict: role === 'reviewer' ? 'APPROVE' : 'PASS',
    objectives: objectiveIds.map((id) => ({ id, met: true })),
    findings: []
  }
}

/** A reviewer/security verdict carrying findings — the verdict is derived (spec Rev 3.3 item 3), not asserted independently. */
export function blockingVerdict(
  role: 'reviewer' | 'security',
  findings: VerdictObservation['findings'],
  objectiveIds: string[] = []
): VerdictObservation {
  return {
    role,
    verdict: role === 'reviewer' ? 'REQUEST CHANGES' : 'FAIL',
    objectives: objectiveIds.map((id) => ({ id, met: true })),
    findings
  }
}

export function escalateVerdict(role: 'reviewer' | 'security'): VerdictObservation {
  return { role, verdict: 'ESCALATE', objectives: [], findings: [] }
}

/** A clean verdict whose objectives block carries one `NOT MET` entry — O3's "regardless of findings" case. */
export function notMetVerdict(role: 'reviewer' | 'security', objectiveIds: string[]): VerdictObservation {
  return {
    role,
    verdict: role === 'reviewer' ? 'APPROVE' : 'PASS',
    objectives: objectiveIds.map((id, i) => ({ id, met: i !== 0 })),
    findings: []
  }
}

/**
 * Drives `assessRound` through a scripted sequence of observations, threading
 * state forward and concatenating every emitted event — the shape Part 1's
 * byte-for-byte event-list assertion needs. Returns the final state, the flat
 * event list, and every decision returned along the way (in order).
 *
 * `clockAt` is the task's wall clock as the real driver would read it before
 * each step, by step index — the scripted equivalent of a run whose elapsed
 * time grows between observations. Omitted, no clock is passed at all, which
 * is exactly a caller that cannot measure the task's first start: the time
 * budget is then never armed and every existing scenario behaves as before.
 */
export function runScenario(
  initial: LoopState,
  steps: Observations[],
  clockAt?: (index: number) => TaskClock | undefined
): { state: LoopState; events: DevReviewLoopEventInput[]; decisions: Decision[] } {
  let state = initial
  const events: DevReviewLoopEventInput[] = []
  const decisions: Decision[] = []
  for (const [index, step] of steps.entries()) {
    const result = assessRound(state, step, clockAt?.(index))
    state = result.state
    events.push(...result.events)
    decisions.push(result.decision)
  }
  return { state, events, decisions }
}
