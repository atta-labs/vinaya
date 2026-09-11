import { describe, expect, it } from 'bun:test'
import { isRunFailed } from '../../src/commands/check'
import type { CheckOutcome, CheckSpec } from '../../src/checks/contract'

const PRINCIPAL_OWED_SPEC: CheckSpec = {
  name: 'test-plan',
  run: 'x',
  scope: 'diff',
  principalOwed: true
}

const OTHER_SPEC: CheckSpec = { name: 'typecheck', run: 'y', scope: 'full' }

function outcome(name: string, status: CheckOutcome['status'], errors: CheckOutcome['errors'] = []): CheckOutcome {
  return { name, status, exitCode: status === 'pass' ? 0 : 1, errors, durationMs: 1 }
}

describe('isRunFailed (review-validity-v1 11, O1)', () => {
  it('a run whose only red is a principalOwed check, all-pending, is NOT failed', () => {
    const outcomes = [outcome('test-plan', 'fail', [{ ...ERR, pending: true }]), outcome('typecheck', 'pass')]
    expect(isRunFailed(outcomes, [PRINCIPAL_OWED_SPEC, OTHER_SPEC])).toBe(false)
  })

  it('a principalOwed check failing for a STRUCTURAL (non-pending) reason still fails the run', () => {
    const outcomes = [outcome('test-plan', 'fail', [{ ...ERR }]), outcome('typecheck', 'pass')]
    expect(isRunFailed(outcomes, [PRINCIPAL_OWED_SPEC, OTHER_SPEC])).toBe(true)
  })

  it('a principalOwed check with a MIX of pending and non-pending errors still fails the run', () => {
    const outcomes = [
      outcome('test-plan', 'fail', [{ ...ERR, pending: true }, { ...ERR }]),
      outcome('typecheck', 'pass')
    ]
    expect(isRunFailed(outcomes, [PRINCIPAL_OWED_SPEC, OTHER_SPEC])).toBe(true)
  })

  it('a non-principalOwed check failing still fails the run regardless of any other pending check', () => {
    const outcomes = [outcome('test-plan', 'fail', [{ ...ERR, pending: true }]), outcome('typecheck', 'fail', [ERR])]
    expect(isRunFailed(outcomes, [PRINCIPAL_OWED_SPEC, OTHER_SPEC])).toBe(true)
  })

  it('an all-pass run is not failed', () => {
    const outcomes = [outcome('test-plan', 'pass'), outcome('typecheck', 'pass')]
    expect(isRunFailed(outcomes, [PRINCIPAL_OWED_SPEC, OTHER_SPEC])).toBe(false)
  })

  it('a principalOwed check with zero errors reported (status error/timeout, nothing to inspect) still fails the run', () => {
    const outcomes = [outcome('test-plan', 'error', []), outcome('typecheck', 'pass')]
    expect(isRunFailed(outcomes, [PRINCIPAL_OWED_SPEC, OTHER_SPEC])).toBe(true)
  })
})

const ERR = {
  schema: 1 as const,
  check: 'test-plan',
  severity: 'error' as const,
  message: 'x',
  agent_recovery_prompt: 'y'
}
