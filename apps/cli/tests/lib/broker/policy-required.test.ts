/**
 * The broker's policy seams, owned by the broker itself: building one without
 * any of its three policies is refused, naming the missing one; and the
 * authorization logic runs over whatever role, path and launch-record facts
 * the policies carry. Every role label and protected path here is synthetic —
 * no process's own vocabulary — so these tests prove the enforcement, not a
 * process's facts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ControlStoreDeps, defaultControlStoreDeps } from '@attalabs/aeg-core'
import {
  type BrokerPolicies,
  createBroker,
  ForgedInvocationError,
  MissingBrokerPolicyError,
  ProtectedPathError,
  scopeTarget
} from '../../../../../harness/kernel/tools/host/broker'

const noLog = (): void => {}

function syntheticPolicies(seen: { protectedAsked: string[] } = { protectedAsked: [] }): BrokerPolicies {
  return {
    protectedPaths: {
      isProtected: (normalizedPath) => {
        seen.protectedAsked.push(normalizedPath)
        return normalizedPath === 'locked' || normalizedPath.startsWith('locked/')
      }
    },
    launchRecords: { matchesRun: (runId, role, task) => runId === 'run-1' && role === 'alpha' && task === 3 },
    roles: { recognizedRoles: ['alpha', 'beta'], workerRoles: ['alpha'], surfaceOwner: 'the Steward' }
  }
}

describe('createBroker — a missing policy is a refusal, never a default', () => {
  it('refuses no policies at all, naming the first missing one', () => {
    expect(() => createBroker(undefined as unknown as BrokerPolicies)).toThrow(
      'broker: refusing to build without its protected-path policy (protectedPaths)'
    )
  })

  for (const [policy, name] of [
    ['protectedPaths', 'protected-path policy'],
    ['launchRecords', 'launch-record verifier'],
    ['roles', 'role policy']
  ] as const) {
    it(`refuses a broker built without its ${name}`, () => {
      const policies = { ...syntheticPolicies(), [policy]: undefined } as unknown as BrokerPolicies
      let thrown: unknown
      try {
        createBroker(policies)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(MissingBrokerPolicyError)
      expect((thrown as MissingBrokerPolicyError).policy).toBe(policy)
      expect((thrown as Error).message).toBe(`broker: refusing to build without its ${name} (${policy})`)
    })
  }

  it('refuses a malformed policy as missing: an empty object answers nothing', () => {
    expect(() => createBroker({ ...syntheticPolicies(), protectedPaths: {} } as unknown as BrokerPolicies)).toThrow(
      MissingBrokerPolicyError
    )
    expect(() => createBroker({ ...syntheticPolicies(), launchRecords: {} } as unknown as BrokerPolicies)).toThrow(
      MissingBrokerPolicyError
    )
    expect(() =>
      createBroker({
        ...syntheticPolicies(),
        roles: { recognizedRoles: ['alpha'], workerRoles: ['alpha'] }
      } as unknown as BrokerPolicies)
    ).toThrow('(roles)')
  })
})

describe('authentication reads the role policy and the launch-record verifier', () => {
  const broker = createBroker(syntheticPolicies())

  it('admits a role the policy maps to the Worker channel, launched for the claimed task', () => {
    const ctx = broker.authenticateWorkerInvocation(
      { VINAYA_ROLE: 'alpha', VINAYA_TASK: '3', VINAYA_RUN_ID: 'run-1' },
      noLog
    )
    expect(ctx.role).toBe('worker')
    expect(ctx.task).toBe(3)
  })

  it('refuses a recognized role the policy grants no Worker channel', () => {
    expect(() =>
      broker.authenticateWorkerInvocation({ VINAYA_ROLE: 'beta', VINAYA_TASK: '3', VINAYA_RUN_ID: 'run-1' }, noLog)
    ).toThrow('VINAYA_ROLE "beta" does not map to a broker-grantable Worker role')
  })

  it('refuses a role outside the policy’s closed set', () => {
    expect(() =>
      broker.authenticateWorkerInvocation({ VINAYA_ROLE: 'gamma', VINAYA_TASK: '3', VINAYA_RUN_ID: 'run-1' }, noLog)
    ).toThrow('VINAYA_ROLE "gamma" is not a recognized dispatched role at all')
  })

  it('refuses a task the verifier finds no launch record for', () => {
    expect(() =>
      broker.authenticateWorkerInvocation({ VINAYA_ROLE: 'alpha', VINAYA_TASK: '4', VINAYA_RUN_ID: 'run-1' }, noLog)
    ).toThrow(ForgedInvocationError)
  })
})

describe('the push refusal reads the protected-path policy, after normalization', () => {
  let dir: string
  let deps: ControlStoreDeps
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'broker-policy-required-'))
    deps = defaultControlStoreDeps(() => dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  let pushes = 0
  const push = (
    broker: ReturnType<typeof createBroker>,
    touchedPaths: string[],
    surfaceCoversPath?: (path: string) => boolean
  ) => {
    const ctx = broker.authenticateWorkerInvocation(
      { VINAYA_ROLE: 'alpha', VINAYA_TASK: '3', VINAYA_RUN_ID: 'run-1' },
      noLog
    )
    return broker.requestEffect(
      deps,
      ctx,
      {
        operation: 'branch-push',
        target: scopeTarget(3, 'refs/heads/task/x/3'),
        inputVersion: 1,
        touchedPaths,
        ...(surfaceCoversPath ? { surfaceCoversPath } : {}),
        key: `push-${++pushes}`,
        payload: 'sha',
        poster: () => 'pushed',
        reconcile: () => ({ outcome: 'absent' })
      },
      noLog
    )
  }

  it('asks the policy about the normalized path only, and refuses a disguised protected path', () => {
    const seen = { protectedAsked: [] as string[] }
    const broker = createBroker(syntheticPolicies(seen))
    let thrown: unknown
    try {
      push(broker, ['../locked/x', './open/../locked/y'])
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ProtectedPathError)
    expect((thrown as Error).message).toBe(
      "broker: refusing an operation that touches a protected administrative policy path: ../locked/x — the task's Surface does not cover it; the Steward must add the path to the task's Surface"
    )
    expect(seen.protectedAsked).toEqual(['locked/x'])
  })

  it('hands the Surface check the same normalized path, and admits a covered one', () => {
    const covered: string[] = []
    const broker = createBroker(syntheticPolicies())
    const result = push(broker, ['./locked/z'], (path) => {
      covered.push(path)
      return true
    })
    expect(result).toBe('pushed')
    expect(covered).toEqual(['locked/z'])
  })

  it('admits a path the policy does not protect', () => {
    expect(push(createBroker(syntheticPolicies()), ['open/file.ts'])).toBe('pushed')
  })
})
