import { describe, expect, it } from 'bun:test'
import type { CallerContext } from '../../../src/lib/task-tools/server.js'
import {
  createTaskStartHandler,
  defaultLaunch,
  TASK_RUN_COMMAND_ENV,
  type RequestStore,
  type StartRecord
} from '../../../src/lib/task-tools/start.js'

/**
 * `task_start` (O2) driven in-process with injected deps: an in-memory
 * idempotency store and a recording launcher, so every branch — validation,
 * the absent-caller refusal, the first start, the idempotent replay, and a
 * launch failure — is exercised with no real forge, git, or detached process.
 * The protocol-level end-to-end path (a real client over stdio, disconnect
 * leaves one run) is `protocol.test.ts`.
 */

const REPO_ROOT = '/repo/checkout-a'
const CALLER: CallerContext = { caller: { id: 'operator-1' } }
const NO_CALLER: CallerContext = { caller: null }

function memStore(): { store: RequestStore; map: Map<string, StartRecord> } {
  const map = new Map<string, StartRecord>()
  return {
    map,
    store: {
      claim(record) {
        const existing = map.get(record.requestId)
        if (existing) return { claimed: false, record: existing }
        map.set(record.requestId, record)
        return { claimed: true, record }
      },
      release(requestId) {
        map.delete(requestId)
      }
    }
  }
}

function harness(overrides: { launch?: () => void; repoRoot?: string | null } = {}) {
  const launches: Array<{ tranche: string; id: string }> = []
  const { store, map } = memStore()
  const handler = createTaskStartHandler({
    repoRoot: () => overrides.repoRoot ?? REPO_ROOT,
    store,
    launch: (target) => {
      // Override first: a throwing launcher records nothing, mirroring a real
      // detached spawn that fails before it starts.
      overrides.launch?.()
      launches.push(target)
    },
    now: () => '2026-01-01T00:00:00.000Z'
  })
  return { handler, launches, map }
}

describe('task_start handler', () => {
  it('refuses malformed input with a validation error, before any caller check or launch', async () => {
    const { handler, launches } = harness()
    const result = await handler({}, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
    expect(launches).toHaveLength(0)
  })

  it('refuses with an authority error when the invocation context carries no caller', async () => {
    const { handler, launches } = harness()
    const result = await handler({ tranche: 'task-operator-v1', id: '2' }, NO_CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('authority')
    expect(launches).toHaveLength(0)
  })

  it('starts the run once and returns the durable run identity', async () => {
    const { handler, launches } = harness()
    const result = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.started).toBe(true)
    expect(result.result.run).toEqual({ tranche: 'task-operator-v1', id: '2' })
    expect(result.result.mode).toBe('attended')
    expect(result.result.requestId).toMatch(/^req_/)
    expect(launches).toEqual([{ tranche: 'task-operator-v1', id: '2' }])
  })

  it('is idempotent per request identity — a duplicate start returns the same run and launches nothing new', async () => {
    const { handler, launches } = harness()
    const first = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    const second = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.result.requestId).toBe(first.result.requestId)
    expect(second.result.started).toBe(false)
    expect(second.result.startedAt).toBe(first.result.startedAt)
    expect(launches).toHaveLength(1)
  })

  it('scopes the request identity to the caller — a different caller is a distinct start', async () => {
    const { handler, launches } = harness()
    const a = await handler({ tranche: 'task-operator-v1', id: '2' }, { caller: { id: 'operator-1' } })
    const b = await handler({ tranche: 'task-operator-v1', id: '2' }, { caller: { id: 'operator-2' } })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.result.requestId).not.toBe(b.result.requestId)
    expect(launches).toHaveLength(2)
  })

  it('scopes the request identity to the local checkout — two repos sharing the durable store never collide', async () => {
    const launches: Array<{ tranche: string; id: string }> = []
    const { store: sharedStore } = memStore()
    const handlerFor = (root: string) =>
      createTaskStartHandler({
        repoRoot: () => root,
        store: sharedStore,
        launch: (target) => launches.push(target),
        now: () => '2026-01-01T00:00:00.000Z'
      })
    const a = await handlerFor('/repo/checkout-a')({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    const b = await handlerFor('/repo/checkout-b')({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.result.requestId).not.toBe(b.result.requestId)
    expect(a.result.started).toBe(true)
    expect(b.result.started).toBe(true)
    expect(launches).toHaveLength(2)
  })

  it('is unaffected by a flaky repo lookup — the same underlying checkout always computes the same identity', async () => {
    // A network-resolved repo (the old identity input) can return successfully
    // on one call and fail transiently on the next for the same checkout;
    // `repoRoot` never does, since it is local and synchronous — this pins that
    // the identity computation itself has no such input to begin with.
    const { handler: first } = harness({ repoRoot: REPO_ROOT })
    const a = await first({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    const { handler: second } = harness({ repoRoot: REPO_ROOT })
    const b = await second({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.result.requestId).toBe(b.result.requestId)
  })

  it('releases the claimed identity when the launch fails synchronously, so a retry can start it', async () => {
    let fail = true
    const { handler, launches, map } = harness({
      launch: () => {
        if (fail) throw new Error('launcher missing')
      }
    })
    const first = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error.kind).toBe('infrastructure')
    expect(map.size).toBe(0) // claim released — no stale record blocking a retry

    fail = false
    const retry = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.result.started).toBe(true)
    // one recorded push from the retry (the failed attempt threw before recording nothing durable)
    expect(launches).toHaveLength(1)
  })

  it('releases the claimed identity when the launch fails asynchronously, without throwing', async () => {
    // The real launcher (`defaultLaunch`) reports a failure that surfaces only
    // after `spawn` already returned (ENOENT for a missing binary) through the
    // third `onAsyncFailure` callback, not a throw — this pins that the
    // handler wires that callback to a claim release, and that invoking it
    // never itself throws back into the caller (a spawned child's own `error`
    // event has nowhere to propagate a throw to).
    const { store, map } = memStore()
    let capturedFailure: ((err: Error) => void) | undefined
    const handler = createTaskStartHandler({
      repoRoot: () => REPO_ROOT,
      store,
      launch: (_target, _meta, onAsyncFailure) => {
        capturedFailure = onAsyncFailure
      },
      now: () => '2026-01-01T00:00:00.000Z'
    })

    const result = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.started).toBe(true)
    expect(map.size).toBe(1) // claimed while the launch is still "in flight"

    expect(capturedFailure).toBeDefined()
    expect(() => capturedFailure?.(new Error('spawn vinaya ENOENT'))).not.toThrow()
    expect(map.size).toBe(0) // released once the async failure is reported

    const retry = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.result.started).toBe(true) // the identity is free to start again
  })

  it('defaultLaunch itself reports a real ENOENT through onAsyncFailure, never as an unhandled error', async () => {
    const original = process.env[TASK_RUN_COMMAND_ENV]
    process.env[TASK_RUN_COMMAND_ENV] = '/does/not/exist/vinaya-launcher-fixture'
    try {
      const failure = await new Promise<Error>((resolve) => {
        defaultLaunch({ tranche: 'task-operator-v1', id: '2' }, { requestId: 'req_x', caller: 'operator-1' }, resolve)
      })
      expect(failure.message).toContain('ENOENT')
    } finally {
      if (original === undefined) delete process.env[TASK_RUN_COMMAND_ENV]
      else process.env[TASK_RUN_COMMAND_ENV] = original
    }
  })
})
