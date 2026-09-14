/**
 * `authenticateWorkerInvocation`/`authenticateOperatorInvocation` (Issue
 * #557, O1) — the invocation-context authentication half of the broker,
 * exercised on its own before `requestEffect`'s grant/ownership checks.
 */

import { describe, expect, it } from 'bun:test'
import { authenticateOperatorInvocation, authenticateWorkerInvocation, ForgedInvocationError } from '../../../src/lib/broker'

describe('authenticateWorkerInvocation', () => {
  it('maps VINAYA_ROLE=developer to the worker broker role, task parsed from VINAYA_TASK', () => {
    const ctx = authenticateWorkerInvocation({ VINAYA_ROLE: 'developer', VINAYA_TASK: '2' })
    expect(ctx).toEqual({ role: 'worker', task: 2 })
  })

  it('refuses a role never dispatched as a child process at all (forged principal claim)', () => {
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'principal', VINAYA_TASK: '2' })).toThrow(
      ForgedInvocationError
    )
  })

  it('refuses a real but non-Worker dispatched role (code-reviewer holds no Worker grant)', () => {
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'code-reviewer', VINAYA_TASK: '2' })).toThrow(
      ForgedInvocationError
    )
  })

  it('refuses an arbitrary, out-of-vocabulary role string', () => {
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'super-admin', VINAYA_TASK: '2' })).toThrow(
      ForgedInvocationError
    )
  })

  it('refuses a missing VINAYA_ROLE', () => {
    expect(() => authenticateWorkerInvocation({ VINAYA_TASK: '2' })).toThrow(ForgedInvocationError)
  })

  it('refuses a missing, non-numeric, zero or negative VINAYA_TASK', () => {
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'developer' })).toThrow(ForgedInvocationError)
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'developer', VINAYA_TASK: 'x' })).toThrow(
      ForgedInvocationError
    )
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'developer', VINAYA_TASK: '0' })).toThrow(
      ForgedInvocationError
    )
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'developer', VINAYA_TASK: '-1' })).toThrow(
      ForgedInvocationError
    )
  })
})

describe('authenticateOperatorInvocation', () => {
  it('authenticates through VINAYA_MCP_CALLER, the same channel task-tools/server.ts already uses', () => {
    const ctx = authenticateOperatorInvocation({ VINAYA_MCP_CALLER: 'operator-session-1' }, 2)
    expect(ctx).toEqual({ role: 'operator', task: 2 })
  })

  it('refuses when no caller was authenticated on this invocation', () => {
    expect(() => authenticateOperatorInvocation({}, 2)).toThrow(ForgedInvocationError)
    expect(() => authenticateOperatorInvocation({ VINAYA_MCP_CALLER: '   ' }, 2)).toThrow(ForgedInvocationError)
  })

  it('refuses a non-positive task id even with a valid caller', () => {
    expect(() => authenticateOperatorInvocation({ VINAYA_MCP_CALLER: 'operator-session-1' }, 0)).toThrow(
      ForgedInvocationError
    )
  })
})
