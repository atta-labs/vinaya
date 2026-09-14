/**
 * Operator grant matrix — "Operator grants allow selected-task execution
 * and observation only; human resolution uses a separately authenticated
 * channel and denial tests cover forged role names and replayed
 * capabilities."
 *
 * "Human resolution uses a separately authenticated channel" is proven
 * here by ABSENCE, not a special-cased refusal: `human-resolve` is not in
 * `OPERATOR_OPERATIONS`, so it is refused the same generic way any
 * ungranted operation is — there is no broker code path that grants it to
 * any role at all. A pause/resume/cancel decision, or the ruling that
 * unblocks one, is asked of the Principal's own `forge-write.ts`
 * `refuseUnlessPrincipal` gate, never authenticated through this module.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ControlStoreDeps, defaultControlStoreDeps } from '@attalabs/aeg-core'
import {
  authenticateOperatorInvocation,
  authenticateWorkerInvocation,
  ForgedInvocationError,
  type InvocationContext,
  OPERATOR_OPERATIONS,
  ReplayedInputVersionError,
  requestEffect,
  scopeTarget,
  UngrantedOperationError
} from '../../../src/lib/broker'

let dir: string
let deps: ControlStoreDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'broker-operator-grants-test-'))
  deps = defaultControlStoreDeps(() => dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const operator: InvocationContext = { role: 'operator', task: 4 }

describe('Operator grant matrix', () => {
  for (const operation of OPERATOR_OPERATIONS) {
    it(`allows '${operation}' — selected-task execution/observation`, () => {
      let posts = 0
      const url = requestEffect(deps, operator, {
        operation,
        target: scopeTarget(4, 'task:4'),
        inputVersion: 1,
        key: `matrix-${operation}`,
        payload: operation,
        poster: () => {
          posts++
          return `https://example.com/${operation}`
        },
        reconcile: () => {
          throw new Error('reconcile should not be called for a fresh key')
        }
      })
      expect(posts).toBe(1)
      expect(url).toBe(`https://example.com/${operation}`)
    })
  }

  it("denies 'human-resolve' — no role's grant includes it; a paused run's decision goes through the Principal's own separately authenticated channel", () => {
    let posts = 0
    expect(() =>
      requestEffect(deps, operator, {
        operation: 'human-resolve',
        target: scopeTarget(4, 'task:4'),
        inputVersion: 1,
        key: 'matrix-human-resolve',
        payload: 'resume',
        poster: () => {
          posts++
          return 'https://example.com'
        },
        reconcile: () => {
          throw new Error('reconcile should not be called for a fresh key')
        }
      })
    ).toThrow(UngrantedOperationError)
    expect(posts).toBe(0)
  })

  it('denies a Worker-only operation to the Operator role — the two grants are disjoint by role, not by operation name alone', () => {
    expect(() =>
      requestEffect(deps, operator, {
        operation: 'branch-push',
        target: scopeTarget(4, 'task/worker-isolation-v1/4'),
        inputVersion: 1,
        key: 'matrix-cross-role',
        payload: 'x',
        poster: () => 'https://example.com',
        reconcile: () => {
          throw new Error('reconcile should not be called for a fresh key')
        }
      })
    ).toThrow(UngrantedOperationError)
  })
})

describe('forged role names (O3 denial test)', () => {
  it('a dispatched child cannot claim VINAYA_ROLE=operator — the value is not in the dispatched-role map at all', () => {
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'operator', VINAYA_TASK: '4' })).toThrow(
      ForgedInvocationError
    )
  })

  it('an Operator invocation with no authenticated caller cannot be used to request even a granted operation', () => {
    expect(() => authenticateOperatorInvocation({ VINAYA_ROLE: 'developer' }, 4)).toThrow(ForgedInvocationError)
  })

  it('a forged worker role reaching requestEffect directly (bypassing authenticate*) is still refused by the grant check for an operator-only operation', () => {
    const forged: InvocationContext = { role: 'worker', task: 4 }
    expect(() =>
      requestEffect(deps, forged, {
        operation: 'task-execute',
        target: scopeTarget(4, 'task:4'),
        inputVersion: 1,
        key: 'forged-worker-task-execute',
        payload: 'x',
        poster: () => 'https://example.com',
        reconcile: () => {
          throw new Error('reconcile should not be called for a fresh key')
        }
      })
    ).toThrow(UngrantedOperationError)
  })
})

describe('replayed capabilities (O3 denial test)', () => {
  it("a captured task-execute request replayed with the task's stale (already-superseded) inputVersion is refused, never re-executed", () => {
    requestEffect(deps, operator, {
      operation: 'task-execute',
      target: scopeTarget(4, 'task:4'),
      inputVersion: 3,
      key: 'task-execute-4',
      payload: 'round 3 start',
      poster: () => 'https://example.com/run/3',
      reconcile: () => {
        throw new Error('reconcile should not be called for a fresh key')
      }
    })

    let posts = 0
    expect(() =>
      requestEffect(deps, operator, {
        operation: 'task-execute',
        target: scopeTarget(4, 'task:4'),
        inputVersion: 1,
        key: 'task-execute-4',
        payload: 'a captured, replayed round 1 start request',
        poster: () => {
          posts++
          return 'https://example.com/run/1'
        },
        reconcile: () => {
          throw new Error('reconcile should not be called for a fresh key')
        }
      })
    ).toThrow(ReplayedInputVersionError)
    expect(posts).toBe(0)
  })

  it('an IDENTICAL replayed request (same identity, same key) is idempotent — the poster runs once, the recorded URL is returned again, never a second effect', () => {
    let posts = 0
    const request = {
      operation: 'task-execute',
      target: scopeTarget(4, 'task:4'),
      inputVersion: 1,
      key: 'task-execute-idempotent',
      payload: 'round 1 start',
      poster: () => {
        posts++
        return 'https://example.com/run/1'
      },
      reconcile: () => {
        throw new Error('reconcile should not be called for a fresh key')
      }
    }
    const first = requestEffect(deps, operator, request)
    const second = requestEffect(deps, operator, request)
    expect(posts).toBe(1)
    expect(second).toBe(first)
  })
})
