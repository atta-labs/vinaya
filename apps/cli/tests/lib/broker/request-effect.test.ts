/**
 * `requestEffect` — target binding, protected-path refusal,
 * replayed-input-version refusal, and delegation to the SAME epoch-fenced
 * `EffectExecutor` every other control-store writer already uses ("owner
 * epoch checked", this task's Test Plan).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ControlStoreDeps, defaultControlStoreDeps, StaleEpochWriteError } from '@attalabs/aeg-core'
import type { DispatchTeeRecoveryDeps } from '../../../src/lib/dispatch'
import {
  acquireOwnership,
  authenticateWorkerInvocation,
  ProtectedPathError,
  ReplayedInputVersionError,
  requestEffect,
  scopeTarget,
  UnboundTargetError,
  UngrantedOperationError
} from '../../../src/lib/broker'

let dir: string
let deps: ControlStoreDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'broker-request-effect-test-'))
  deps = defaultControlStoreDeps(() => dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A launch record naming exactly the (runId, role, task) triple `authenticateWorkerInvocation` below presents — the same shape `dispatch.ts`'s own launcher would have durably written before spawning this child. */
const WORKER_DISPATCH_DEPS: DispatchTeeRecoveryDeps = {
  env: {},
  listLaunchRecordPaths: () => ['launch-0.json'],
  readFile: () => JSON.stringify({ runId: 'run-request-effect', role: 'developer', agent: 'claude', task: 2 })
}

const worker = authenticateWorkerInvocation(
  { VINAYA_ROLE: 'developer', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-request-effect' },
  WORKER_DISPATCH_DEPS
)

const neverReconcile = () => {
  throw new Error('reconcile should not be called for a fresh key')
}

describe('requestEffect', () => {
  it('grants a Worker operation and calls the effect executor exactly once (O1)', () => {
    let posts = 0
    const url = requestEffect(deps, worker, {
      operation: 'branch-push',
      target: scopeTarget(2, 'task/worker-isolation-v1/2'),
      inputVersion: 1,
      key: 'push-1',
      payload: 'commit-sha-abc',
      poster: () => {
        posts++
        return 'https://github.com/example/repo/tree/task/worker-isolation-v1/2'
      },
      reconcile: neverReconcile
    })
    expect(posts).toBe(1)
    expect(url).toContain('worker-isolation-v1/2')
  })

  it('refuses an ungranted operation before ever calling the poster', () => {
    let posts = 0
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'ruling-post',
        target: scopeTarget(2, 'task/worker-isolation-v1/2'),
        inputVersion: 1,
        key: 'ruling-1',
        payload: 'x',
        poster: () => {
          posts++
          return 'https://example.com'
        },
        reconcile: neverReconcile
      })
    ).toThrow(UngrantedOperationError)
    expect(posts).toBe(0)
  })

  it("refuses a target scoped to a different task, even naming that task's OWN real branch (target string is what's checked, not a trusted side field)", () => {
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'branch-push',
        target: scopeTarget(5, 'task/worker-isolation-v1/5'),
        inputVersion: 1,
        key: 'push-1',
        payload: 'x',
        poster: () => 'https://example.com',
        reconcile: neverReconcile
      })
    ).toThrow(UnboundTargetError)
  })

  it('refuses a plain, unscoped target — a caller cannot bypass task-binding by simply omitting the `<task>:` prefix `scopeTarget` requires', () => {
    let posts = 0
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'branch-push',
        // Not built via scopeTarget: no task prefix at all.
        target: 'task/worker-isolation-v1/2',
        inputVersion: 1,
        key: 'push-1',
        payload: 'x',
        poster: () => {
          posts++
          return 'https://example.com'
        },
        reconcile: neverReconcile
      })
    ).toThrow(UnboundTargetError)
    expect(posts).toBe(0)
  })

  it('refuses a target whose scoped task prefix does not match its own numeric value read literally (defends the parse itself, not just the compare)', () => {
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'branch-push',
        // A hand-forged string mimicking scopeTarget's shape but naming a
        // different task in the prefix than the invocation actually holds.
        target: '999:task/worker-isolation-v1/2',
        inputVersion: 1,
        key: 'push-1',
        payload: 'x',
        poster: () => 'https://example.com',
        reconcile: neverReconcile
      })
    ).toThrow(UnboundTargetError)
  })

  it('refuses an operation touching a protected administrative policy path, regardless of role', () => {
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'branch-push',
        target: scopeTarget(2, 'task/worker-isolation-v1/2'),
        inputVersion: 1,
        key: 'push-1',
        payload: 'x',
        touchedPaths: ['vinaya.config.json'],
        poster: () => 'https://example.com',
        reconcile: neverReconcile
      })
    ).toThrow(ProtectedPathError)
  })

  it.each([
    ['foo/../.github/workflows/ci.yml', 'a `..` segment that resolves back onto a protected prefix'],
    ['./.github/x', 'a leading `./` that defeats a raw `startsWith` compare'],
    ['/aeg-root/x', 'a leading `/` that makes the path look absolute'],
    ['../.github/workflows/ci.yml', 'a leading, unresolved `..` with nothing preceding it to cancel against'],
    ['../../aeg-root/x', 'two leading unresolved `..` segments']
  ])('refuses a protected path disguised by %s (%s)', (path) => {
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'branch-push',
        target: scopeTarget(2, 'task/worker-isolation-v1/2'),
        inputVersion: 1,
        key: `push-disguised-${path}`,
        payload: 'x',
        touchedPaths: [path],
        poster: () => 'https://example.com',
        reconcile: neverReconcile
      })
    ).toThrow(ProtectedPathError)
  })

  it('refuses a replayed capability — a request presenting an inputVersion older than one already recorded for the same key', () => {
    requestEffect(deps, worker, {
      operation: 'pr-comment',
      target: scopeTarget(2, 'pr:1234'),
      inputVersion: 2,
      key: 'comment-1',
      payload: 'round 2 comment',
      poster: () => 'https://example.com/comment/1',
      reconcile: neverReconcile
    })

    let posts = 0
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'pr-comment',
        target: scopeTarget(2, 'pr:1234'),
        inputVersion: 1,
        key: 'comment-1',
        payload: 'a captured, replayed round 1 comment',
        poster: () => {
          posts++
          return 'https://example.com/comment/1'
        },
        reconcile: neverReconcile
      })
    ).toThrow(ReplayedInputVersionError)
    expect(posts).toBe(0)
  })

  it('a genuinely newer inputVersion under the same key is a fresh post, not a replay', () => {
    requestEffect(deps, worker, {
      operation: 'pr-comment',
      target: scopeTarget(2, 'pr:1234'),
      inputVersion: 1,
      key: 'comment-1',
      payload: 'round 1 comment',
      poster: () => 'https://example.com/comment/1',
      reconcile: neverReconcile
    })

    let posts = 0
    const url = requestEffect(deps, worker, {
      operation: 'pr-comment',
      target: scopeTarget(2, 'pr:1234'),
      inputVersion: 2,
      key: 'comment-1',
      payload: 'round 2 comment',
      poster: () => {
        posts++
        return 'https://example.com/comment/2'
      },
      reconcile: neverReconcile
    })
    expect(posts).toBe(1)
    expect(url).toBe('https://example.com/comment/2')
  })

  it('owner epoch checked — a competing epoch acquired mid-flight (inside the poster) makes the write refuse rather than land silently', () => {
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'branch-push',
        target: scopeTarget(2, 'task/worker-isolation-v1/2'),
        inputVersion: 1,
        key: 'push-race',
        payload: 'x',
        poster: () => {
          // Simulates a second, concurrent broker request for the same task
          // racing this one — the epoch this call acquired is no longer
          // current by the time this write tries to record 'verified'.
          const racer = acquireOwnership(deps, 2, 'racer')
          expect(racer.acquired).toBe(true)
          return 'https://example.com'
        },
        reconcile: neverReconcile
      })
    ).toThrow(StaleEpochWriteError)
  })
})
