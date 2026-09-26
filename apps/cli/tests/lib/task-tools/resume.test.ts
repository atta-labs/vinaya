import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireOwnership, defaultControlStoreDeps, type EscalationInput, writeEscalation } from '@attalabs/aeg-core'
import type { AgentVendor } from '../../../src/lib/dispatch.js'
import type { CallerContext } from '../../../src/lib/task-tools/server.js'
import {
  createTaskResumeHandler,
  defaultResumeLaunch,
  RESUME_COMMAND_ENV,
  RESUME_STALE_CLAIM_GRACE_MS,
  type LaunchResult,
  type ResumeClaimStore,
  type ResumeRecord
} from '../../../src/lib/task-tools/resume.js'
import { isDriverPidAlive, readDriverLock, writePauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'

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

/**
 * A published round in the control store's own layout — both verdict effects
 * at `verified` under `<task>/control/effect/<key>.json`, plus the `loop_state`
 * record whose `round` bounds the shared `newestPublishedRound` reader — the
 * same shape a clean publish leaves behind (retires the old flat
 * `control/effect-<key>.json` markers this task removed).
 */
function markRoundPublished(round: number) {
  const control = join(outbox, 'tasks-execution', String(ISSUE), 'control')
  mkdirSync(control, { recursive: true })
  writeFileSync(
    join(control, 'loop-state.json'),
    JSON.stringify({
      version: 1,
      kind: 'loop_state',
      task: ISSUE,
      round,
      phase: 'publish',
      pauseReason: null,
      budgets: { mechanicalRetries: 0, reviewRounds: round, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: null,
      recordedAt: '2026-01-01T00:00:00.000Z'
    })
  )
  const effectDir = join(control, 'effect')
  mkdirSync(effectDir, { recursive: true })
  for (const role of ['reviewer', 'security'] as const) {
    const key = `${round}-${role}-verdict`
    writeFileSync(
      join(effectDir, `${key}.json`),
      JSON.stringify({
        version: 1,
        kind: 'effect',
        task: ISSUE,
        key,
        operation: 'pr-comment',
        target: `pr:${PR}`,
        inputVersion: round,
        payloadDigest: 'digest',
        status: 'verified',
        url: 'https://example.test/comment',
        recordedAt: '2026-01-01T00:00:00.000Z'
      })
    )
  }
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
      update(record) {
        // Never creates a claim — the same rule the durable store's own `r+`
        // write enforces.
        if (map.has(record.escalationId)) map.set(record.escalationId, record)
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
    launch?: (
      target: { pr: number; agent: AgentVendor; issue: number },
      meta: { escalationId: string; caller: string }
    ) => LaunchResult | Promise<LaunchResult>
    resolveIssue?: (ref: unknown) => number | null
    isPidAlive?: (pid: number) => boolean
    now?: () => string
  } = {}
) {
  const launches: Array<{ pr: number; agent: AgentVendor; issue: number }> = []
  const events: Array<{ operation: string; target: string; result: string; error_class: string | null }> = []
  const { store, map } = memClaimStore()
  const handler = createTaskResumeHandler({
    runtimeDir: () => outbox,
    resolveIssueForRef: (overrides.resolveIssue as never) ?? (() => ISSUE),
    fetchRulings: () => overrides.rulings ?? ['LGTM, resume.'],
    fetchNewestRulingAuthor: () => 'principal-1',
    fetchNewestRulingOrdinal: () => overrides.newestRulingOrdinal ?? 1,
    store,
    isPidAlive: overrides.isPidAlive ?? (() => false),
    launch: async (target, meta) => {
      launches.push(target)
      return (overrides.launch?.(target, meta) ?? { status: 'confirmed', pid: null }) as
        | LaunchResult
        | Promise<LaunchResult>
    },
    now: overrides.now ?? (() => '2026-01-01T00:00:00.000Z'),
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

  it('refuses a published run that holds no pause, naming the round it published at (O2)', async () => {
    // The log-server failure: the loop published clean verdicts and cleared
    // nothing else, so there is no pause on disk — a generic "no paused run"
    // refusal reads as a task that never ran. The refusal names the published
    // round instead.
    markRoundPublished(1)
    const { handler, launches, events } = harness()
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('precondition')
      expect(result.error.message).toBe(
        `task ${ISSUE}'s run already published at round 1 and holds no pause — nothing to resume`
      )
    }
    expect(launches).toHaveLength(0)
    expect(events).toEqual([
      { operation: 'task_resume', target: `task:${ISSUE}`, result: 'refused', error_class: 'precondition' }
    ])
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
    expect(launches).toEqual([{ pr: PR, agent: 'claude', issue: ISSUE }])
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

  it("reports a failed start carrying the continuation's own error output, and releases the claim (O1)", async () => {
    writePause()
    writeEscalationFixture()
    const { handler, launches, map } = harness({
      launch: () => ({
        status: 'exited',
        error: new Error('process exited before its driver confirmed alive (code 2)')
      })
    })
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('infrastructure')
      expect(result.error.message).toContain('code 2')
      expect(result.error.detail).toContain('code 2')
    }
    expect(map.size).toBe(0) // released — an identical retry launches again
    expect(launches).toHaveLength(1)
  })

  it('a retry after a failed start launches again rather than replaying the dead attempt', async () => {
    writePause()
    writeEscalationFixture()
    let alive = false
    const { handler, launches } = harness({
      launch: () => (alive ? { status: 'confirmed', pid: null } : { status: 'exited', error: new Error('no agent') })
    })
    const first = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(first.ok).toBe(false)

    alive = true
    const retry = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.result.outcome).toBe('started')
    expect(launches).toHaveLength(2)
  })

  it('reports a continuation still alive when the confirm wait ends as started, and keeps its claim (O1)', async () => {
    // A continuation whose driver lock has not appeared inside the bounded
    // wait is still a launched, live process — reporting it failed and
    // releasing its claim is what would let a repeat call hand the same
    // escalation to a second continuation.
    writePause()
    writeEscalationFixture()
    const { handler, launches, map } = harness({ launch: () => ({ status: 'starting', pid: 4242 }) })
    const result = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.outcome).toBe('started')
    expect(launches).toHaveLength(1)
    expect(map.size).toBe(1) // the claim is KEPT
    expect([...map.values()][0]?.pid).toBe(4242) // …and names the process it launched
  })

  it('never launches a second continuation while the one it launched is still alive (O2)', async () => {
    writePause()
    writeEscalationFixture()
    let now = '2026-01-01T00:00:00.000Z'
    const { handler, launches } = harness({
      launch: () => ({ status: 'starting', pid: 4242 }),
      isPidAlive: (pid) => pid === 4242,
      now: () => now
    })
    expect((await handler({ task: { issue: ISSUE } }, CALLER)).ok).toBe(true)

    // Past the stale grace, with no driver lock ever written for this
    // fixture's task — the launched process is the only liveness signal
    // there is, and it says the continuation is still coming up.
    now = new Date(Date.parse(now) + RESUME_STALE_CLAIM_GRACE_MS + 60_000).toISOString()
    const second = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.result.outcome).toBe('already_resumed')
    expect(launches).toHaveLength(1)
  })

  it('supersedes a stale claim once the continuation it launched has exited too (O2)', async () => {
    writePause()
    writeEscalationFixture()
    let now = '2026-01-01T00:00:00.000Z'
    let childAlive = true
    const { handler, launches } = harness({
      launch: () => ({ status: 'starting', pid: 4242 }),
      isPidAlive: () => childAlive,
      now: () => now
    })
    expect((await handler({ task: { issue: ISSUE } }, CALLER)).ok).toBe(true)

    now = new Date(Date.parse(now) + RESUME_STALE_CLAIM_GRACE_MS + 60_000).toISOString()
    childAlive = false
    const second = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.result.outcome).toBe('started') // superseded and relaunched
    expect(launches).toHaveLength(2)
  })

  /**
   * The same rule against a REAL detached continuation: a launcher whose own
   * driver lock lands after the confirm wait has ended. The wait is shortened
   * here so the fixture costs a second rather than the shipped ten; the spawn,
   * the race and the liveness reads are the real ones.
   */
  it('a continuation slower than the wait is started, keeps its claim, and a repeat call launches nothing (O3)', async () => {
    writePause()
    writeEscalationFixture()
    const argvLog = join(sandbox, 'argv.log')
    const script = join(sandbox, 'slow-continuation.sh')
    const taskDir = join(outbox, 'tasks-execution', String(ISSUE))
    mkdirSync(taskDir, { recursive: true })
    // Sleeps well past both the shortened wait and the repeat call below, so
    // the repeat is decided by the claim — not by a driver lock that has
    // already appeared, which the gate above would refuse on instead.
    writeFileSync(
      script,
      `#!/bin/sh\necho "$@" >> "${argvLog}"\nsleep 2\necho '{"pid": '"$$"', "startedAt": "2026-01-01T00:00:00.000Z"}' > "${taskDir}/driver.pid.json"\nexec sleep 5\n`,
      { mode: 0o755 }
    )
    const original = process.env[RESUME_COMMAND_ENV]
    let launched: number | null = null
    try {
      process.env[RESUME_COMMAND_ENV] = script
      const { handler, launches } = harness({
        launch: (target, meta) =>
          defaultResumeLaunch(target, meta, outbox, 200).then((result) => {
            if (result.status !== 'exited') launched = result.pid
            return result
          }),
        isPidAlive: isDriverPidAlive
      })

      const first = await handler({ task: { issue: ISSUE } }, CALLER)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      expect(first.result.outcome).toBe('started') // still coming up, never a failed start

      const second = await handler({ task: { issue: ISSUE } }, CALLER)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.result.outcome).toBe('already_resumed')
      expect(launches).toHaveLength(1)

      // Let it finish coming up: the run is there, and the launcher's own
      // record shows one invocation, never a second continuation.
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline && readDriverLock(outbox, ISSUE) === null) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const lock = readDriverLock(outbox, ISSUE)
      expect(lock !== null && isDriverPidAlive(lock.pid)).toBe(true)
      expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
        `dev-review-loop --resume ${PR} --agent claude`
      ])
    } finally {
      if (launched !== null) {
        try {
          process.kill(-launched, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
      if (original === undefined) delete process.env[RESUME_COMMAND_ENV]
      else process.env[RESUME_COMMAND_ENV] = original
    }
  })

  it('replays a claim still within its own confirm window without relaunching (O3, no race)', async () => {
    // The driver-lock gate above already proves no live driver exists before
    // this call ever reaches the claim step; without the staleness guard, a
    // second call racing the first's own in-flight confirm-wait would
    // wrongly treat the first's claim as dead and launch a second worker.
    writePause()
    writeEscalationFixture()
    const { handler, launches } = harness()
    const first = await handler({ task: { issue: ISSUE } }, CALLER)
    const second = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.result.outcome).toBe('already_resumed')
    expect(launches).toHaveLength(1)
  })

  it('supersedes a stale claim once its task has no live driver, and relaunches (O3)', async () => {
    writePause()
    writeEscalationFixture()
    let now = '2026-01-01T00:00:00.000Z'
    const { handler, launches } = harness({ now: () => now })
    const first = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.result.outcome).toBe('started')

    // Time passes well past the confirm window — no driver lock was ever
    // written for this fixture's `ISSUE`, so the run this claim named is
    // (and always was) dead by the time this second call arrives.
    now = new Date(Date.parse(now) + RESUME_STALE_CLAIM_GRACE_MS + 1_000).toISOString()
    const second = await handler({ task: { issue: ISSUE } }, CALLER)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.result.outcome).toBe('started') // superseded and relaunched, not replayed
    expect(second.result.escalationId).toBe(first.result.escalationId)
    expect(launches).toHaveLength(2)
  })
})
