/**
 * `EffectExecutor` (Issue #552) — the Test Plan's five named behaviors:
 * intent persisted before the write, a confirmed marker found on a rerun
 * posts nothing twice, a changed payload under the same key is a new
 * identity rather than a retry, a lost acknowledgement reconciles against
 * the remote (confirmed / absent / ambiguous) instead of blindly retrying,
 * and a stale owner is refused.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  type ControlStoreDeps,
  defaultControlStoreDeps,
  readEffect,
  StaleEpochWriteError
} from '@attalabs/aeg-core'
import {
  createEffectExecutor,
  EffectExecutor,
  EffectRetryRefusedError,
  type EffectReconcileResult,
  sha256Hex
} from '../../../src/lib/effects'
import type { LogEventInput } from '../../../src/lib/log-sink'

let dir: string
let deps: ControlStoreDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'effects-executor-test-'))
  deps = defaultControlStoreDeps(() => dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const neverReconcile = (): EffectReconcileResult => {
  throw new Error('reconcile should not be called for a fresh key')
}

function executorFor(task: number, ownerId = 'owner-a'): EffectExecutor {
  const acquired = acquireOwnership(deps, task, ownerId)
  if (!acquired.acquired) throw new Error('test setup: could not acquire a control-store epoch')
  return new EffectExecutor(deps, task, acquired.epoch)
}

describe('EffectExecutor', () => {
  it('persists the effect intent through the control store before the poster is ever called (O1)', () => {
    const executor = createEffectExecutor(deps, 1, 'owner-a')
    let sawStartedBeforePost = false
    const url = executor.execute({
      key: 'k1',
      identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
      poster: () => {
        const mid = readEffect(deps, 1, 'k1')
        sawStartedBeforePost = mid.status === 'ok' && mid.value.status === 'started'
        return 'https://example.com/comment/1'
      },
      reconcile: neverReconcile
    })
    expect(sawStartedBeforePost).toBe(true)
    expect(url).toBe('https://example.com/comment/1')
    expect(readEffect(deps, 1, 'k1')).toMatchObject({ status: 'ok', value: { status: 'verified', url } })
  })

  it('a marker already verified is found on a rerun and returns without reposting (marker found → no repeat)', () => {
    const executor = createEffectExecutor(deps, 1, 'owner-a')
    let posts = 0
    const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') }
    const run = () =>
      executor.execute({
        key: 'k1',
        identity,
        poster: () => {
          posts++
          return 'https://example.com/comment/1'
        },
        reconcile: neverReconcile
      })

    const first = run()
    const second = run()
    expect(posts).toBe(1)
    expect(second).toBe(first)
  })

  it('a changed payload under the same key is treated as a new identity, not a retry of the old one (changed payload → new identity)', () => {
    const executor = createEffectExecutor(deps, 1, 'owner-a')
    let posts = 0
    const poster = () => {
      posts++
      return `https://example.com/comment/${posts}`
    }
    const first = executor.execute({
      key: 'k1',
      identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body v1') },
      poster,
      reconcile: neverReconcile
    })
    const second = executor.execute({
      key: 'k1',
      identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body v2') },
      poster,
      reconcile: neverReconcile
    })
    expect(posts).toBe(2)
    expect(second).not.toBe(first)
    expect(readEffect(deps, 1, 'k1')).toMatchObject({
      status: 'ok',
      value: { status: 'verified', url: second, payloadDigest: sha256Hex('body v2') }
    })
  })

  it('a wrong target under the same key, operation, inputVersion and payloadDigest is treated as a new identity, not a retry of the old one (O3: wrong-target)', () => {
    // Every OTHER field held fixed — only `target` differs — proves the
    // executor's own `sameIdentity` compares `target` too, not only
    // `payloadDigest`: a marker recorded against one PR/Issue must never be
    // read as evidence for a different one (`reconcileGhComment`'s own
    // `ref` binding depends on this never happening — see its unit tests in
    // `forge-write.test.ts`).
    const executor = createEffectExecutor(deps, 1, 'owner-a')
    let posts = 0
    const poster = () => {
      posts++
      return `https://example.com/comment/${posts}`
    }
    const first = executor.execute({
      key: 'k1',
      identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
      poster,
      reconcile: neverReconcile
    })
    const second = executor.execute({
      key: 'k1',
      identity: { operation: 'pr-comment', target: 'pr:2', inputVersion: 1, payloadDigest: sha256Hex('body') },
      poster,
      reconcile: neverReconcile
    })
    expect(posts).toBe(2)
    expect(second).not.toBe(first)
    expect(readEffect(deps, 1, 'k1')).toMatchObject({
      status: 'ok',
      value: { status: 'verified', url: second, target: 'pr:2' }
    })
  })

  it('a lost acknowledgement whose remote read is ambiguous stays uncertain and refuses every later retry (lost ack → uncertain)', () => {
    const task = 1
    const key = 'k1'
    const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') }
    const executor = executorFor(task)

    // Simulate a crash between the forge accepting the write and the local
    // confirmation landing: the poster itself throws, so `postAndRecord`
    // persisted the 'started' intent but never reached the 'verified' write.
    expect(() =>
      executor.execute({
        key,
        identity,
        poster: () => {
          throw new Error('simulated crash after the forge accepted the write')
        },
        reconcile: neverReconcile
      })
    ).toThrow('simulated crash')
    expect(readEffect(deps, task, key)).toMatchObject({ status: 'ok', value: { status: 'started' } })

    // Recovery reconciles — the remote read itself failed, so the outcome
    // cannot be told apart from a genuine post: stays uncertain, refused.
    expect(() =>
      executor.execute({
        key,
        identity,
        poster: () => {
          throw new Error('poster must not be called while reconciling')
        },
        reconcile: () => ({ outcome: 'ambiguous', reason: 'gh unreachable' })
      })
    ).toThrow(EffectRetryRefusedError)
    expect(readEffect(deps, task, key)).toMatchObject({ status: 'ok', value: { status: 'uncertain' } })

    // Once uncertain, a later attempt is refused again without ever
    // consulting `reconcile` a second time — never blindly replayed.
    expect(() =>
      executor.execute({
        key,
        identity,
        poster: () => {
          throw new Error('poster must not be called')
        },
        reconcile: () => {
          throw new Error('reconcile must not be called once uncertain')
        }
      })
    ).toThrow(EffectRetryRefusedError)
  })

  it('a lost acknowledgement whose remote read confirms genuine absence completes the interrupted post', () => {
    const task = 1
    const key = 'k1'
    const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') }
    const executor = executorFor(task)

    expect(() =>
      executor.execute({
        key,
        identity,
        poster: () => {
          throw new Error('crash')
        },
        reconcile: neverReconcile
      })
    ).toThrow('crash')

    let posts = 0
    const url = executor.execute({
      key,
      identity,
      poster: () => {
        posts++
        return 'https://example.com/comment/recovered'
      },
      reconcile: () => ({ outcome: 'absent' })
    })
    expect(posts).toBe(1)
    expect(url).toBe('https://example.com/comment/recovered')
  })

  it('a lost acknowledgement whose remote read confirms the write already landed returns its url, never reposting', () => {
    const task = 1
    const key = 'k1'
    const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') }
    const executor = executorFor(task)

    expect(() =>
      executor.execute({
        key,
        identity,
        poster: () => {
          throw new Error('crash')
        },
        reconcile: neverReconcile
      })
    ).toThrow('crash')

    let posts = 0
    const url = executor.execute({
      key,
      identity,
      poster: () => {
        posts++
        return 'should-not-be-called'
      },
      reconcile: () => ({ outcome: 'confirmed', url: 'https://example.com/comment/already-there' })
    })
    expect(posts).toBe(0)
    expect(url).toBe('https://example.com/comment/already-there')
  })

  it("refuses a write once the caller no longer holds the task's current control-store epoch (stale owner refused)", () => {
    const task = 1
    const stale = executorFor(task, 'owner-a')

    // A second owner takes over — the first executor's own epoch is now stale.
    const second = acquireOwnership(deps, task, 'owner-b')
    expect(second.acquired).toBe(true)

    expect(() =>
      stale.execute({
        key: 'k1',
        identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
        poster: () => 'https://example.com/comment/1',
        reconcile: neverReconcile
      })
    ).toThrow(StaleEpochWriteError)
  })

  it('refuses rather than guesses when the existing record is corrupt, never silently treating it as absent', () => {
    const task = 1
    const executor = executorFor(task)
    // Write directly through the store's own write path, then corrupt it —
    // this executor never produces malformed JSON itself; a corrupt record
    // models external tampering or a torn write from something else.
    executor.execute({
      key: 'k1',
      identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
      poster: () => 'https://example.com/comment/1',
      reconcile: neverReconcile
    })
    writeFileSync(join(dir, '1', 'effect', 'k1.json'), 'not json', 'utf8')

    expect(() =>
      executor.execute({
        key: 'k1',
        identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
        poster: () => {
          throw new Error('poster must not be called over a corrupt record')
        },
        reconcile: neverReconcile
      })
    ).toThrow(EffectRetryRefusedError)
  })
})

/**
 * task-log-v1 task 6 (O1): the `effect` log family's `attempted`/`observed`/
 * `verified` outcomes, one call per real external write and one idempotent
 * `verified` observation per replay — never a second `attempted` for a
 * replay that performed no new write. `effect_id` is the control-store
 * `key` itself, held fixed across every event in one test (O3: idempotent
 * observation identities).
 */
describe('EffectExecutor — effect log events (task-log-v1 task 6, O1/O3)', () => {
  function loggingExecutor(task: number, ownerId = 'owner-a'): { executor: EffectExecutor; events: LogEventInput[] } {
    const events: LogEventInput[] = []
    const acquired = acquireOwnership(deps, task, ownerId)
    if (!acquired.acquired) throw new Error('test setup: could not acquire a control-store epoch')
    return { executor: new EffectExecutor(deps, task, acquired.epoch, (e) => events.push(e)), events }
  }

  it('emits attempted → observed(success) → verified(success), all under the same effect_id, for a fresh write', () => {
    const { executor, events } = loggingExecutor(1)
    executor.execute({
      key: 'k1',
      identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
      poster: () => 'https://example.com/comment/1',
      reconcile: neverReconcile
    })
    expect(events.map((e) => e.event)).toEqual(['attempted', 'observed', 'verified'])
    const effectIds = new Set(events.map((e) => (e as { effect_id: string }).effect_id))
    expect(effectIds).toEqual(new Set(['k1']))
    expect((events[1] as { outcome: string }).outcome).toBe('success')
    expect((events[2] as { outcome: string }).outcome).toBe('success')
  })

  it('an idempotent replay of an already-verified write emits only a verified(success) observation — never a second attempted', () => {
    const { executor, events } = loggingExecutor(1)
    const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') }
    executor.execute({ key: 'k1', identity, poster: () => 'https://example.com/comment/1', reconcile: neverReconcile })
    events.length = 0
    executor.execute({
      key: 'k1',
      identity,
      poster: () => {
        throw new Error('poster must not be called on an idempotent replay')
      },
      reconcile: neverReconcile
    })
    expect(events.map((e) => e.event)).toEqual(['verified'])
    expect((events[0] as { effect_id: string }).effect_id).toBe('k1')
  })

  it('a poster failure emits attempted → observed(failure), never a verified event, and rethrows', () => {
    const { executor, events } = loggingExecutor(1)
    expect(() =>
      executor.execute({
        key: 'k1',
        identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
        poster: () => {
          throw new Error('simulated crash')
        },
        reconcile: neverReconcile
      })
    ).toThrow('simulated crash')
    expect(events.map((e) => e.event)).toEqual(['attempted', 'observed'])
    expect((events[1] as { outcome: string }).outcome).toBe('failure')
  })

  it('a lost acknowledgement that reconciles ambiguous emits observed(uncertain), visible rather than silently dropped (O3: visible gaps)', () => {
    const { executor, events } = loggingExecutor(1)
    const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') }
    expect(() =>
      executor.execute({
        key: 'k1',
        identity,
        poster: () => {
          throw new Error('crash')
        },
        reconcile: neverReconcile
      })
    ).toThrow('crash')
    events.length = 0
    expect(() =>
      executor.execute({
        key: 'k1',
        identity,
        poster: () => {
          throw new Error('poster must not be called while reconciling')
        },
        reconcile: () => ({ outcome: 'ambiguous', reason: 'gh unreachable' })
      })
    ).toThrow(EffectRetryRefusedError)
    expect(events.map((e) => e.event)).toEqual(['observed'])
    expect((events[0] as { outcome: string; effect_id: string }).outcome).toBe('uncertain')
    expect((events[0] as { effect_id: string }).effect_id).toBe('k1')
  })

  it("a reconciliation confirming the write already landed emits observed(success) → verified(success), never a repeated 'attempted'", () => {
    const { executor, events } = loggingExecutor(1)
    const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') }
    expect(() =>
      executor.execute({
        key: 'k1',
        identity,
        poster: () => {
          throw new Error('crash')
        },
        reconcile: neverReconcile
      })
    ).toThrow('crash')
    events.length = 0
    executor.execute({
      key: 'k1',
      identity,
      poster: () => 'should-not-be-called',
      reconcile: () => ({ outcome: 'confirmed', url: 'https://example.com/comment/already-there' })
    })
    expect(events.map((e) => e.event)).toEqual(['observed', 'verified'])
  })

  it('a corrupt existing record emits observed(uncertain), the SAME line the ambiguous-reconciliation branch emits, before refusing (round 2 review, MAJOR)', () => {
    const { executor, events } = loggingExecutor(1)
    executor.execute({
      key: 'k1',
      identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
      poster: () => 'https://example.com/comment/1',
      reconcile: neverReconcile
    })
    writeFileSync(join(dir, '1', 'effect', 'k1.json'), 'not json', 'utf8')
    events.length = 0
    expect(() =>
      executor.execute({
        key: 'k1',
        identity: { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: sha256Hex('body') },
        poster: () => {
          throw new Error('poster must not be called over a corrupt record')
        },
        reconcile: neverReconcile
      })
    ).toThrow(EffectRetryRefusedError)
    expect(events.map((e) => e.event)).toEqual(['observed'])
    expect((events[0] as { outcome: string; effect_id: string }).outcome).toBe('uncertain')
    expect((events[0] as { effect_id: string }).effect_id).toBe('k1')
  })
})
