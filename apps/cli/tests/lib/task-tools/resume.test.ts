import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireOwnership, defaultControlStoreDeps, type EscalationInput, writeEscalation } from '@attalabs/aeg-core'
import type { CallerContext } from '../../../src/lib/task-tools/server.js'
import {
  createTaskResumeHandler,
  type ResumeClaimStore,
  type ResumeRecord
} from '../../../src/lib/task-tools/resume.js'
import { writePauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'

/**
 * `task_resume` (task-operator-v1 4, O1) driven in-process with injected
 * deps and a real, temp-directory-backed outbox/control-store — the SAME
 * durable records `dev-review-loop --resume` reads, so every gate (no
 * pause, no PR yet, a stale/superseded pause, a missing or wrong-target
 * escalation record, a live driver lock, no Principal ruling, an already-
 * consumed resolution) is exercised against real reads, never a mocked
 * shortcut. `fetchRulings`/`fetchNewestRulingAuthor`/`fetchNewestRulingOrdinal`
 * and the launcher are injected — no real `gh` call, no real detached spawn.
 */

const CALLER: CallerContext = { caller: { id: 'operator-1' } }
const NO_CALLER: CallerContext = { caller: null }
const ISSUE = 558
const PR = 900

let sandbox: string
let outbox: string
let controlStoreDeps: ReturnType<typeof defaultControlStoreDeps>

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vinaya-task-resume-'))
  outbox = join(sandbox, 'outbox')
  mkdirSync(outbox, { recursive: true })
  controlStoreDeps = defaultControlStoreDeps(() => join(outbox, 'tasks-execution'))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function writePause(overrides: Partial<Parameters<typeof writePauseState>[1]> = {}) {
  writePauseState(outbox, {
    task: ISSUE,
    round: 1,
    head: 'headsha1',
    branch: 'task/x/1',
    prNumber: PR,
    reason: 'escalation',
    pausedAt: '2026-01-01T00:00:00.000Z',
    escalationId: `${ISSUE}-1-headsha1`,
    ...overrides
  })
}

function writeEscalationFixture(overrides: Partial<EscalationInput> = {}) {
  const acquired = acquireOwnership(controlStoreDeps, ISSUE, 'test-fixture')
  if (!acquired.acquired) throw new Error('fixture: could not acquire epoch')
  return writeEscalation(controlStoreDeps, ISSUE, acquired.epoch, {
    escalationId: `${ISSUE}-1-headsha1`,
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

function markRoundPublished(round: number) {
  const dir = join(outbox, 'tasks-execution', String(ISSUE), 'control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `effect-${round}-reviewer-verdict.json`), JSON.stringify({ effectId: 'r', status: 'posted' }))
  writeFileSync(join(dir, `effect-${round}-security-verdict.json`), JSON.stringify({ effectId: 's', status: 'posted' }))
}

function memClaimStore(): { store: ResumeClaimStore; map: Map<string, ResumeRecord> } {
  const map = new Map<string, ResumeRecord>()
  return {
    map,
    store: {
      claim(record) {
        const existing = map.get(record.escalationId)
        if (existing) return { claimed: false, record: existing }
        map.set(record.escalationId, record)
        return { claimed: true, record }
      },
      release(escalationId) {
        map.delete(escalationId)
      }
    }
  }
}

function harness(
  overrides: {
    rulings?: string[]
    newestRulingOrdinal?: number
    launch?: () => void
    resolveIssue?: (ref: unknown) => number | null
  } = {}
) {
  const launches: Array<{ pr: number; agent: string }> = []
  const events: Array<{ operation: string; target: string; result: string; error_class: string | null }> = []
  const { store, map } = memClaimStore()
  const handler = createTaskResumeHandler({
    runtimeDir: () => outbox,
    resolveIssueForRef: (overrides.resolveIssue as never) ?? (() => ISSUE),
    fetchRulings: () => overrides.rulings ?? ['LGTM, resume.'],
    fetchNewestRulingAuthor: () => 'principal-1',
    fetchNewestRulingOrdinal: () => overrides.newestRulingOrdinal ?? 1,
    store,
    launch: (target, _meta, onAsyncFailure) => {
      overrides.launch?.()
      launches.push(target)
      void onAsyncFailure
    },
    now: () => '2026-01-01T00:00:00.000Z',
    log: (e) => {
      if (e.kind === 'operation')
        events.push({ operation: e.operation, target: e.target ?? '', result: e.result, error_class: e.error_class })
    }
  })
  return { handler, launches, map, events }
}

describe('task_resume handler', () => {
  it('refuses malformed input with a validation error', async () => {
    const { handler, launches } = harness()
    const result = await handler({}, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
    expect(launches).toHaveLength(0)
  })

  it('refuses with an authority error when the invocation context carries no caller', async () => {
    const { handler, launches } = harness()
    const result = await handler({ task: { issue: ISSUE } }, NO_CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('authority')
    expect(launches).toHaveLength(0)
  })

  it('refuses when no pause is recorded for the task', async () => {
    const { handler } = harness()
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('precondition')
  })

  it('refuses when the pause carries no PR yet', async () => {
    writePause({ prNumber: null as unknown as number })
    const { handler } = harness()
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('precondition')
  })

  it('refuses a stale pause — a later round has already published', async () => {
    writePause()
    markRoundPublished(1)
    const { handler } = harness()
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('precondition')
  })

  it('refuses when the escalation has no durable record at all', async () => {
    writePause()
    const { handler } = harness()
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('precondition')
      expect(result.error.message).toContain('no durable record')
    }
  })

  it('rejects a wrong-target decision — the escalation names a different PR', async () => {
    writePause()
    writeEscalationFixture({ pr: PR + 1 })
    const { handler } = harness()
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('precondition')
      expect(result.error.message).toContain('names PR 901, not PR 900')
    }
  })

  it('rejects a forged decision — no Principal ruling posted yet', async () => {
    writePause()
    writeEscalationFixture()
    const { handler, launches, events } = harness({ rulings: [] })
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('authority')
    expect(launches).toHaveLength(0)
    expect(events).toEqual([
      { operation: 'task_resume', target: `task:${ISSUE}`, result: 'refused', error_class: 'authority' }
    ])
  })

  it('rejects a stale ruling — its ordinal has not advanced past the one this escalation was already raised under', async () => {
    writePause()
    writeEscalationFixture({ rulingOrdinal: 1 })
    const { handler, launches, events } = harness({ newestRulingOrdinal: 1 })
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('authority')
      expect(result.error.message).toContain('no newer than the ruling this escalation was already raised under')
    }
    expect(launches).toHaveLength(0)
    expect(events).toEqual([
      { operation: 'task_resume', target: `task:${ISSUE}`, result: 'refused', error_class: 'authority' }
    ])
  })

  it('accepts a valid, authenticated resume and triggers the existing continuation exactly once', async () => {
    writePause()
    writeEscalationFixture()
    const { handler, launches, events } = harness()
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('started')
    expect(result.result.pr).toBe(PR)
    expect(result.result.authenticatedBy).toBe('principal-1')
    expect(launches).toEqual([{ pr: PR, agent: 'claude' }])
    expect(events).toEqual([{ operation: 'task_resume', target: `task:${ISSUE}`, result: 'ok', error_class: null }])
  })

  it('is idempotent per escalation — a duplicate call never launches a second worker', async () => {
    writePause()
    writeEscalationFixture()
    const { handler, launches } = harness()
    const first = await handler({ task: { issue: ISSUE } }, CALLER)
    const second = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.result.outcome).toBe('started')
    expect(second.result.outcome).toBe('already_resumed')
    expect(launches).toHaveLength(1)
  })

  it('refuses when the run already has a live driver — never starts a second worker', async () => {
    writePause()
    writeEscalationFixture()
    const lockDir = join(outbox, 'tasks-execution', String(ISSUE))
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(
      join(lockDir, 'driver.pid.json'),
      JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' })
    )
    const { handler, launches } = harness()
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('second worker')
    expect(launches).toHaveLength(0)
  })
})
