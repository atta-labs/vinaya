/**
 * `requestEffect` (Issue #557, O1) — target binding, protected-path
 * refusal, replayed-input-version refusal, and delegation to the SAME
 * epoch-fenced `EffectExecutor` every other control-store writer already
 * uses ("owner epoch checked", this task's Test Plan).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ControlStoreDeps, defaultControlStoreDeps, StaleEpochWriteError } from '@attalabs/aeg-core'
import {
  acquireOwnership,
  type InvocationContext,
  ProtectedPathError,
  ReplayedInputVersionError,
  requestEffect,
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

const worker: InvocationContext = { role: 'worker', task: 2 }

const neverReconcile = () => {
  throw new Error('reconcile should not be called for a fresh key')
}

describe('requestEffect', () => {
  it('grants a Worker operation and calls the effect executor exactly once (O1)', () => {
    let posts = 0
    const url = requestEffect(deps, worker, {
      operation: 'branch-push',
      target: 'task/worker-isolation-v1/2',
      targetTask: 2,
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
        target: 'task/worker-isolation-v1/2',
        targetTask: 2,
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

  it("refuses a request whose targetTask is not the invocation's own task (branch-write bound to the current task)", () => {
    expect(() =>
      requestEffect(deps, worker, {
        operation: 'branch-push',
        target: 'task/worker-isolation-v1/5',
        targetTask: 5,
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
        target: 'task/worker-isolation-v1/2',
        targetTask: 2,
        inputVersion: 1,
        key: 'push-1',
        payload: 'x',
        touchedPaths: ['vinaya.config.json'],
        poster: () => 'https://example.com',
        reconcile: neverReconcile
      })
    ).toThrow(ProtectedPathError)
  })

  it('refuses a replayed capability — a request presenting an inputVersion older than one already recorded for the same key', () => {
    requestEffect(deps, worker, {
      operation: 'pr-comment',
      target: 'pr:1234',
      targetTask: 2,
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
        target: 'pr:1234',
        targetTask: 2,
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
      target: 'pr:1234',
      targetTask: 2,
      inputVersion: 1,
      key: 'comment-1',
      payload: 'round 1 comment',
      poster: () => 'https://example.com/comment/1',
      reconcile: neverReconcile
    })

    let posts = 0
    const url = requestEffect(deps, worker, {
      operation: 'pr-comment',
      target: 'pr:1234',
      targetTask: 2,
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
        target: 'task/worker-isolation-v1/2',
        targetTask: 2,
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
