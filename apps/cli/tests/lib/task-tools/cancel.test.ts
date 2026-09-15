import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  consumeResolutionOnce,
  defaultControlStoreDeps,
  type EscalationInput,
  listStartedEffectKeys,
  markEffectUncertain,
  readEffect,
  StaleEpochWriteError,
  writeEffect,
  writeEscalation
} from '@attalabs/aeg-core'
import type { CallerContext } from '../../../src/lib/task-tools/server.js'
import { createTaskCancelHandler } from '../../../src/lib/task-tools/cancel.js'
import { writePauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'

/**
 * `task_cancel` (task-operator-v1 4, O2) driven in-process against a real,
 * temp-directory-backed outbox/control-store, with `cancelDevReviewLoop`
 * itself INJECTED (a fake standing in for the already-tested real one —
 * `dev-review-loop.test.ts` owns proving the real continuation's own
 * termination/fencing behavior; this suite proves the HANDLER's own
 * translation: outcome classification, idempotent replay, and the forged/
 * stale/wrong-target refusals it detects before ever calling the
 * continuation at all).
 */

const CALLER: CallerContext = { caller: { id: 'operator-1' } }
const NO_CALLER: CallerContext = { caller: null }
const ISSUE = 558
const PR = 900
const ESCALATION_ID = `${ISSUE}-1-headsha1`

let sandbox: string
let outbox: string
let controlStoreDeps: ReturnType<typeof defaultControlStoreDeps>

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vinaya-task-cancel-'))
  outbox = join(sandbox, 'outbox')
  mkdirSync(outbox, { recursive: true })
  controlStoreDeps = defaultControlStoreDeps(() => join(sandbox, 'control-store'))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function writePause() {
  writePauseState(outbox, {
    task: ISSUE,
    round: 1,
    head: 'headsha1',
    branch: 'task/x/1',
    prNumber: PR,
    reason: 'escalation',
    pausedAt: '2026-01-01T00:00:00.000Z',
    escalationId: ESCALATION_ID
  })
}

function writeEscalationFixture(overrides: Partial<EscalationInput> = {}) {
  const acquired = acquireOwnership(controlStoreDeps, ISSUE, 'test-fixture')
  if (!acquired.acquired) throw new Error('fixture: could not acquire epoch')
  return writeEscalation(controlStoreDeps, ISSUE, acquired.epoch, {
    escalationId: ESCALATION_ID,
    round: 1,
    head: 'headsha1',
    branch: 'task/x/1',
    pr: PR,
    runId: 'run-1',
    pid: 12345,
    host: 'test-host',
    agent: 'claude',
    reason: 'escalation',
    attemptedRecovery: 'none',
    requestedDecision: 'resume or cancel',
    recipient: 'principal',
    briefHash: null,
    objectivesVersion: null,
    rulingOrdinal: 0,
    policyDigest: 'digest',
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  })
}

function harness(
  overrides: {
    rulings?: string[]
    hostname?: string
    cancelResult?: { escalationId: string; fencedEffectKeys: string[] }
    cancelError?: Error
  } = {}
) {
  const calls: Array<{ cancelPr: number; agent: string }> = []
  const events: Array<{ operation: string; target: string; result: string; error_class: string | null }> = []
  const handler = createTaskCancelHandler({
    outboxRoot: () => outbox,
    resolveIssueForRef: () => ISSUE,
    fetchRulings: () => overrides.rulings ?? ['LGTM, cancel.'],
    hostname: () => overrides.hostname ?? 'test-host',
    cancelDevReviewLoop: async (input) => {
      calls.push(input)
      if (overrides.cancelError) throw overrides.cancelError
      return {
        task: ISSUE,
        escalationId: overrides.cancelResult?.escalationId ?? ESCALATION_ID,
        fencedEffectKeys: overrides.cancelResult?.fencedEffectKeys ?? []
      }
    },
    log: (e) => {
      if (e.kind === 'operation')
        events.push({ operation: e.operation, target: e.target ?? '', result: e.result, error_class: e.error_class })
    }
  })
  return { handler, calls, events }
}

describe('task_cancel handler', () => {
  it('refuses malformed input with a validation error', async () => {
    const { handler, calls } = harness()
    const result = await handler({}, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
    expect(calls).toHaveLength(0)
  })

  it('refuses with an authority error when the invocation context carries no caller', async () => {
    const { handler } = harness()
    const result = await handler({ task: { issue: ISSUE }, reason: 'no longer needed' }, NO_CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('authority')
  })

  it('refuses when no pause with a PR is recorded', async () => {
    const { handler, calls } = harness()
    const result = await handler({ task: { issue: ISSUE }, reason: 'no longer needed' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('precondition')
    expect(calls).toHaveLength(0)
  })

  it('rejects a forged decision — no Principal ruling posted yet', async () => {
    writePause()
    const { handler, calls } = harness({ rulings: [] })
    const result = await handler({ task: { issue: ISSUE }, reason: 'no longer needed' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('authority')
    expect(calls).toHaveLength(0)
  })

  it('confirms a local cancel with nothing fenced', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { handler, calls, events } = harness({ hostname: 'test-host' })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('confirmed')
    expect(result.result.pr).toBe(PR)
    expect(calls).toEqual([{ cancelPr: PR, agent: 'claude' }])
    expect(events).toEqual([{ operation: 'task_cancel', target: `task:${ISSUE}`, result: 'ok', error_class: null }])
  })

  it('reports pending when the run was dispatched on a different host', async () => {
    writePause()
    writeEscalationFixture({ host: 'a-different-host' })
    const { handler } = harness({ hostname: 'this-host' })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('pending')
  })

  it('reports uncertain when an in-flight effect had to be fenced', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { handler } = harness({
      hostname: 'test-host',
      cancelResult: { escalationId: ESCALATION_ID, fencedEffectKeys: ['effect-1'] }
    })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('uncertain')
    expect(result.result.fencedEffectKeys).toEqual(['effect-1'])
  })

  it('reports the same truthful outcome again on a replayed cancel — never an error', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { ReplayedResolutionError } = await import('../../../src/lib/dev-review-loop/pause-resume.js')
    const err = new ReplayedResolutionError(ISSUE, ESCALATION_ID, {
      version: 1,
      kind: 'resolution',
      task: ISSUE,
      escalationId: ESCALATION_ID,
      decision: 'cancel',
      authenticatedBy: 'principal-1',
      authenticatedFrom: `${PR}-1`,
      consumedAt: '2026-01-01T00:00:00.000Z'
    })
    const { handler } = harness({ hostname: 'test-host', cancelError: err })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('confirmed')
    expect(result.result.authenticatedBy).toBe('principal-1')
  })

  it('refuses a cancel against an escalation already resolved as resume', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { ReplayedResolutionError } = await import('../../../src/lib/dev-review-loop/pause-resume.js')
    const err = new ReplayedResolutionError(ISSUE, ESCALATION_ID, {
      version: 1,
      kind: 'resolution',
      task: ISSUE,
      escalationId: ESCALATION_ID,
      decision: 'resume',
      authenticatedBy: 'principal-1',
      authenticatedFrom: `${PR}-1`,
      consumedAt: '2026-01-01T00:00:00.000Z'
    })
    const { handler } = harness({ hostname: 'test-host', cancelError: err })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('precondition')
      expect(result.error.message).toContain('resume')
    }
  })

  it('fences a late in-flight effect on cancel — a write under the old epoch is refused after', async () => {
    // Exercises the SAME control-store primitives `cancelDevReviewLoop`'s own
    // `resolveEscalation` + `fenceStartedEffectsAsUncertain` compose, against
    // this suite's own sandboxed `controlStoreDeps` (those two convenience
    // wrappers hardcode the real machine control store — see `resume.ts`'s
    // header on why this handler never calls them directly either), proving
    // O3's "cancel and fence a late result" end to end: a write still
    // `'started'` when cancellation runs is fenced to `'uncertain'`, and any
    // later attempt to complete it under the pre-cancel epoch is refused.
    const acquiredBefore = acquireOwnership(controlStoreDeps, ISSUE, 'developer-in-flight')
    if (!acquiredBefore.acquired) throw new Error('fixture: could not acquire epoch')
    const staleEpoch = acquiredBefore.epoch
    writeEffect(controlStoreDeps, ISSUE, staleEpoch, 'late-pr-comment', {
      operation: 'pr-comment',
      target: `pr:${PR}`,
      inputVersion: 1,
      payloadDigest: 'digest-1',
      status: 'started',
      recordedAt: '2026-01-01T00:00:00.000Z'
    })

    // The cancel itself: a fresh epoch, the resolution consumed exactly once,
    // then every still-`'started'` effect fenced under THAT epoch.
    const cancelAcquire = acquireOwnership(controlStoreDeps, ISSUE, 'cancel')
    if (!cancelAcquire.acquired) throw new Error('fixture: could not acquire cancel epoch')
    const consumed = consumeResolutionOnce(controlStoreDeps, ISSUE, cancelAcquire.epoch, {
      escalationId: ESCALATION_ID,
      decision: 'cancel',
      authenticatedBy: 'principal-1',
      authenticatedFrom: `${PR}-1`,
      consumedAt: '2026-01-01T00:01:00.000Z'
    })
    expect(consumed.outcome).toBe('consumed')
    const fenced = listStartedEffectKeys(controlStoreDeps, ISSUE).map(
      (key) => markEffectUncertain(controlStoreDeps, ISSUE, cancelAcquire.epoch, key)?.key
    )
    expect(fenced).toEqual(['late-pr-comment'])
    expect(readEffect(controlStoreDeps, ISSUE, 'late-pr-comment')).toMatchObject({
      status: 'ok',
      value: { status: 'uncertain' }
    })

    // The late result: the in-flight write from BEFORE the cancel finally
    // tries to confirm itself, still holding the now-superseded `staleEpoch`.
    expect(() =>
      writeEffect(controlStoreDeps, ISSUE, staleEpoch, 'late-pr-comment', {
        operation: 'pr-comment',
        target: `pr:${PR}`,
        inputVersion: 1,
        payloadDigest: 'digest-1',
        status: 'verified',
        url: 'https://github.com/example/pr/comment/1',
        recordedAt: '2026-01-01T00:02:00.000Z'
      })
    ).toThrow(StaleEpochWriteError)
  })

  it('surfaces a stale/wrong-target refusal as a precondition error', async () => {
    writePause()
    writeEscalationFixture({ host: 'test-host' })
    const { StaleEscalationError } = await import('../../../src/lib/dev-review-loop/pause-resume.js')
    const err = new StaleEscalationError(ISSUE, ESCALATION_ID, 'no escalation record was ever written for it')
    const { handler } = harness({ hostname: 'test-host', cancelError: err })
    const result = await handler({ task: { issue: ISSUE }, reason: 'superseded' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('precondition')
  })
})
