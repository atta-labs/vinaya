import { describe, expect, it } from 'vitest'
import { normalizeOutcome, type OutcomeSignals } from './outcomes'

/** A clean-run baseline: ran to a natural end, no manner-of-death signal set. Individual cases override only what they exercise. */
function signals(overrides: Partial<OutcomeSignals> = {}): OutcomeSignals {
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    refused: false,
    infrastructure: false,
    artifactsPresent: true,
    postconditionsMet: true,
    ...overrides
  }
}

describe('normalizeOutcome (O2) — exit code is input only, never the decider', () => {
  it('exit 0 with the artifacts present and postconditions met is completed', () => {
    expect(normalizeOutcome(signals({ exitCode: 0 })).status).toBe('completed')
  })

  it('exit 0 WITHOUT a required artifact is incomplete — a clean exit never equates to task success', () => {
    const out = normalizeOutcome(signals({ exitCode: 0, artifactsPresent: false }))
    expect(out.status).toBe('incomplete')
    expect(out.reason).toContain('required artifact is missing')
  })

  it('exit 0 with artifacts present but a postcondition unmet is incomplete', () => {
    const out = normalizeOutcome(signals({ exitCode: 0, postconditionsMet: false }))
    expect(out.status).toBe('incomplete')
    expect(out.reason).toContain('postcondition is unmet')
  })

  it('a NON-zero exit is still completed when the artifacts are genuinely present — the artifacts are the truth, the exit code only the record', () => {
    const out = normalizeOutcome(signals({ exitCode: 3, artifactsPresent: true, postconditionsMet: true }))
    expect(out.status).toBe('completed')
    expect(out.reason).toContain('exit code 3')
  })

  it('a null exit code (no code produced) with missing artifacts is incomplete, not a crash', () => {
    const out = normalizeOutcome(signals({ exitCode: null, artifactsPresent: false }))
    expect(out.status).toBe('incomplete')
    expect(out.reason).toContain('no exit code')
  })
})

describe('normalizeOutcome (O2) — manner-of-death takes precedence over the artifact read', () => {
  it('a refused capability is capability-refused, even with a zero exit and artifacts present', () => {
    expect(normalizeOutcome(signals({ refused: true })).status).toBe('capability-refused')
  })

  it('a cancelled launch is cancelled', () => {
    expect(normalizeOutcome(signals({ cancelled: true })).status).toBe('cancelled')
  })

  it('a timed-out launch is timed-out', () => {
    expect(normalizeOutcome(signals({ timedOut: true, exitCode: null })).status).toBe('timed-out')
  })

  it('an infrastructure failure is infrastructure-failed — never blamed on the task', () => {
    const out = normalizeOutcome(signals({ infrastructure: true, artifactsPresent: false }))
    expect(out.status).toBe('infrastructure-failed')
    expect(out.reason).toContain('not the task itself')
  })

  it('cancellation wins over a coincident timeout — the deliberate stop names the outcome', () => {
    expect(normalizeOutcome(signals({ cancelled: true, timedOut: true })).status).toBe('cancelled')
  })

  it('a refusal wins over every other signal — it happened before anything ran', () => {
    expect(
      normalizeOutcome(signals({ refused: true, cancelled: true, timedOut: true, infrastructure: true })).status
    ).toBe('capability-refused')
  })

  it('a timed-out launch is never reclassified as incomplete just because it left no artifacts', () => {
    // The failure mode this guards: a killed launch reported as `incomplete`
    // blames the task for a ceiling it never controlled.
    expect(normalizeOutcome(signals({ timedOut: true, artifactsPresent: false })).status).toBe('timed-out')
  })
})
