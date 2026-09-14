/**
 * Worker grant matrix — "Worker grants support required branch and change
 * operations without allowing rulings, criteria edits, protected merge or
 * independent review approval publication." Every
 * operation in `WORKER_OPERATIONS` is allowed; every operation in
 * `NEVER_GRANTED_OPERATIONS` is refused BY NAME, not merely by a generic
 * "unknown operation" case — a grant-table edit that accidentally added one
 * of these back would fail this suite immediately.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ControlStoreDeps, defaultControlStoreDeps } from '@attalabs/aeg-core'
import type { DispatchTeeRecoveryDeps } from '../../../src/lib/dispatch'
import {
  authenticateWorkerInvocation,
  NEVER_GRANTED_OPERATIONS,
  requestEffect,
  scopeTarget,
  UngrantedOperationError,
  WORKER_OPERATIONS
} from '../../../src/lib/broker'

let dir: string
let deps: ControlStoreDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'broker-worker-grants-test-'))
  deps = defaultControlStoreDeps(() => dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A launch record naming exactly the (runId, role, task) triple `authenticateWorkerInvocation` below presents. */
const WORKER_DISPATCH_DEPS: DispatchTeeRecoveryDeps = {
  env: {},
  listLaunchRecordPaths: () => ['launch-0.json'],
  readFile: () => JSON.stringify({ runId: 'run-worker-grants', role: 'developer', agent: 'claude', task: 2 })
}

const worker = authenticateWorkerInvocation(
  { VINAYA_ROLE: 'developer', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-worker-grants' },
  WORKER_DISPATCH_DEPS
)

describe('Worker grant matrix', () => {
  for (const operation of WORKER_OPERATIONS) {
    it(`allows '${operation}' — a required branch/change operation`, () => {
      let posts = 0
      const url = requestEffect(deps, worker, {
        operation,
        target: scopeTarget(2, operation === 'branch-push' ? 'task/worker-isolation-v1/2' : 'pr:1234'),
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

  for (const operation of NEVER_GRANTED_OPERATIONS) {
    it(`denies '${operation}' to the Worker role`, () => {
      let posts = 0
      expect(() =>
        requestEffect(deps, worker, {
          operation,
          target: scopeTarget(2, 'task/worker-isolation-v1/2'),
          inputVersion: 1,
          key: `matrix-denied-${operation}`,
          payload: operation,
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
  }

  it('WORKER_OPERATIONS and NEVER_GRANTED_OPERATIONS share no operation name', () => {
    const denied = new Set<string>(NEVER_GRANTED_OPERATIONS)
    for (const op of WORKER_OPERATIONS) {
      expect(denied.has(op)).toBe(false)
    }
  })
})
