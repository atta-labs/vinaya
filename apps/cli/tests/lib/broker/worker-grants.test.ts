/**
 * Worker grant matrix (Issue #557, O2, Part 2) — "Worker grants support
 * required branch and change operations without allowing rulings, criteria
 * edits, protected merge or independent review approval publication." Every
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
import {
  type InvocationContext,
  NEVER_GRANTED_OPERATIONS,
  requestEffect,
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

const worker: InvocationContext = { role: 'worker', task: 2 }

describe('Worker grant matrix', () => {
  for (const operation of WORKER_OPERATIONS) {
    it(`allows '${operation}' — a required branch/change operation`, () => {
      let posts = 0
      const url = requestEffect(deps, worker, {
        operation,
        target: operation === 'branch-push' ? 'task/worker-isolation-v1/2' : 'pr:1234',
        targetTask: 2,
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
          target: 'task/worker-isolation-v1/2',
          targetTask: 2,
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
