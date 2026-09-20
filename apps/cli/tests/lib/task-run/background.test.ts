import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type ControlStoreDeps, readCurrentOwnership, readEffect, readRun, writeEffect } from '@attalabs/aeg-core'
import type { ProcessSnapshot } from '../../../src/lib/dispatch.js'
import { fenceStartedEffectsAsUncertain } from '../../../src/lib/dev-review-loop/pause-resume.js'
import {
  BackgroundUnsupportedError,
  ControllerConflictError,
  findLiveBackgroundController,
  findRecordedControllerRun,
  type SpawnedController,
  type StartBackgroundRunDeps,
  startBackgroundRun
} from '../../../src/lib/task-run-background.js'
import type { RunTaskInput } from '../../../src/lib/task-run.js'

/**
 * `startBackgroundRun` driven entirely with injected deps — a real
 * control-store rooted at a scratch temp directory (the same fault-fixture
 * style `packages/aeg-core/src/control-store/local.test.ts` uses), a
 * recording fake spawn (no real detached process, no real `ps`), and
 * controllable liveness/identity probes. Covers the brief's own Test Plan
 * cases: handle-after-ownership, parent-exit-leaves-controller-alive,
 * status-reattaches, restart-with-no-second-launch, and
 * unsupported-host-refused.
 */

let dir: string
let clock: Date
let nextPid: number
let spawnCalls: Array<{ argv: string[]; opts: { stdioFd: number } }>
let spawnedPids: number[]
let terminated: number[]
let fenced: Array<{ task: number; epoch: number }>
let liveness: Map<number, boolean>
let snapshots: Map<number, ProcessSnapshot | null>

function controlStoreDeps(): ControlStoreDeps {
  return { root: () => dir, now: () => clock, pid: () => 999, hostname: () => 'test-host' }
}

function fakeSpawn(argv: string[], opts: { stdioFd: number }): SpawnedController {
  spawnCalls.push({ argv, opts })
  const pid = nextPid++
  spawnedPids.push(pid)
  liveness.set(pid, true)
  snapshots.set(pid, { ppid: 1, startedAt: `started-${pid}`, command: 'node' })
  return {
    pid,
    unref: () => {},
    on: () => {}
  }
}

function makeDeps(overrides: Partial<StartBackgroundRunDeps> = {}): StartBackgroundRunDeps {
  const controlStore = controlStoreDeps()
  return {
    resolveIssue: async (input: RunTaskInput) => ('issue' in input ? input.issue : 42),
    controlStore,
    isPidAlive: (pid: number) => liveness.get(pid) ?? false,
    getProcessSnapshot: (pid: number) => snapshots.get(pid) ?? null,
    captureSettledChildSnapshot: (pid: number) => snapshots.get(pid) ?? null,
    matchesCapturedIdentity: (record, snapshot) => {
      if (record.childStartedAt !== null && record.childStartedAt !== snapshot.startedAt) return false
      if (record.childCommand !== null && record.childCommand !== snapshot.command) return false
      return true
    },
    terminateChild: (pid: number) => {
      terminated.push(pid)
      liveness.set(pid, false)
    },
    fenceStartedEffects: (task: number, epoch: number) => {
      fenced.push({ task, epoch })
      return fenceStartedEffectsAsUncertain(task, epoch, controlStore)
    },
    spawnDetached: fakeSpawn,
    resolveLoopLogPath: async (task: number) => join(dir, `${task}.log`),
    checkHostSupervisionCapability: () => ({ supported: true }),
    waitForStartup: async () => {},
    ...overrides
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-run-background-test-'))
  clock = new Date('2026-09-15T00:00:00.000Z')
  nextPid = 5000
  spawnCalls = []
  spawnedPids = []
  terminated = []
  fenced = []
  liveness = new Map()
  snapshots = new Map()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('startBackgroundRun', () => {
  it('returns a durable run handle only after the control store records ownership', async () => {
    const deps = makeDeps()
    const handle = await startBackgroundRun({ issue: 42, agent: 'claude' }, deps)

    expect(handle.task).toBe(42)
    expect(handle.epoch).toBe(1)
    expect(handle.runId).toBe('bg-42-1')
    expect(spawnedPids).toEqual([handle.pid])
    expect(handle.host).toBe('test-host')
    expect(handle.logPath).toBe(join(dir, '42.log'))

    // The handle is never a promise on trust — the record it names is
    // actually on disk, under the epoch actually acquired.
    const ownership = readCurrentOwnership(deps.controlStore, 42)
    expect(ownership.epoch).toBe(1)
    const run = readRun(deps.controlStore, 42, handle.runId)
    expect(run.status).toBe('ok')
    if (run.status === 'ok') {
      expect(run.value.pid).toBe(handle.pid)
      expect(run.value.childStartedAt).toBe(`started-${handle.pid}`)
      expect(run.value.childCommand).toBe('node')
    }
  })

  it('refuses a detached child that exits before startup readiness', async () => {
    const deps = makeDeps({
      waitForStartup: async () => {
        liveness.set(5000, false)
      }
    })
    await expect(startBackgroundRun({ issue: 42, agent: 'codex' }, deps)).rejects.toThrow(
      /exited before startup readiness/
    )
  })

  it('spawns a detached, self-reinvoking child and returns without waiting on it — the parent exiting never terminates the controller', async () => {
    const deps = makeDeps()
    const handle = await startBackgroundRun({ tranche: 'control-store-v1', n: 7, agent: 'codex' }, deps)

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.argv).toEqual(['task', 'run', 'control-store-v1', '7', '--agent', 'codex'])
    // `spawnDetached`'s own fake never emits an exit or a completion signal,
    // and `startBackgroundRun` still resolved — nothing in this function's
    // own control flow awaits the child's lifecycle once it is launched and
    // its identity is durably recorded.
    expect(spawnedPids).toEqual([handle.pid])
    expect(liveness.get(handle.pid)).toBe(true)
  })

  // issue-661, round 3 (O1 BLOCKER): the detached child re-parses argv from
  // scratch — an explicit --model given to startBackgroundRun must reach
  // that argv, or the operator's choice is silently lost to the
  // class-mapped/vendor-default model the child resolves on its own.
  it('forwards an explicit --model into the detached child argv', async () => {
    const deps = makeDeps()
    await startBackgroundRun({ tranche: 'control-store-v1', n: 7, agent: 'codex', model: 'claude-opus-5' }, deps)

    expect(spawnCalls[0]?.argv).toEqual([
      'task',
      'run',
      'control-store-v1',
      '7',
      '--agent',
      'codex',
      '--model',
      'claude-opus-5'
    ])
  })

  it('omits --model from the detached child argv when none was given', async () => {
    const deps = makeDeps()
    await startBackgroundRun({ issue: 42, agent: 'claude' }, deps)

    expect(spawnCalls[0]?.argv).toEqual(['task', 'run', '--issue', '42', '--agent', 'claude'])
  })

  it('a repeated background start while the controller is still live reattaches to the SAME run rather than starting another', async () => {
    const deps = makeDeps()
    const first = await startBackgroundRun({ issue: 42, agent: 'claude' }, deps)
    const second = await startBackgroundRun({ issue: 42, agent: 'claude' }, deps)

    expect(second).toEqual(first)
    expect(spawnCalls).toHaveLength(1)

    // `task status`'s own reads (O2) find the identical identity.
    const recorded = findRecordedControllerRun(42, {
      root: deps.controlStore.root,
      hostname: deps.controlStore.hostname,
      isPidAlive: deps.isPidAlive
    })
    expect(recorded).toEqual({ pid: first.pid, startedAt: first.startedAt })
    const live = findLiveBackgroundController(42, {
      root: deps.controlStore.root,
      hostname: deps.controlStore.hostname,
      isPidAlive: deps.isPidAlive,
      getProcessSnapshot: deps.getProcessSnapshot,
      matchesCapturedIdentity: deps.matchesCapturedIdentity
    })
    expect(live).toEqual({ pid: first.pid, startedAt: first.startedAt, epoch: first.epoch })
  })

  it('a restart after the prior controller crashed fences its unconfirmed effects and acquires a fresh epoch — never a second live launch', async () => {
    const deps = makeDeps()
    const first = await startBackgroundRun({ issue: 42, agent: 'claude' }, deps)

    // The dead controller left one forge write unconfirmed.
    writeEffect(deps.controlStore, 42, first.epoch, 'pause-comment', {
      operation: 'gh pr comment',
      target: 'pr-1',
      inputVersion: 0,
      payloadDigest: 'abc',
      status: 'started',
      recordedAt: clock.toISOString()
    })

    // Simulate the crash: the recorded pid no longer answers.
    liveness.set(first.pid, false)

    const second = await startBackgroundRun({ issue: 42, agent: 'claude' }, deps)

    expect(second.epoch).toBe(2)
    expect(second.pid).not.toBe(first.pid)
    expect(spawnCalls).toHaveLength(2)
    expect(fenced).toEqual([{ task: 42, epoch: 1 }])

    const effect = readEffect(deps.controlStore, 42, 'pause-comment')
    expect(effect.status).toBe('ok')
    if (effect.status === 'ok') expect(effect.value.status).toBe('uncertain')

    // The stale run record is left as historical fact; the fresh one is
    // what `task status`/a further reattach now finds.
    const stale = readRun(deps.controlStore, 42, first.runId)
    expect(stale.status).toBe('ok')
    const fresh = readRun(deps.controlStore, 42, second.runId)
    expect(fresh.status).toBe('ok')
  })

  it('refuses a controller recorded on a different host rather than guessing, naming the real host', async () => {
    const deps = makeDeps()
    await startBackgroundRun({ issue: 42, agent: 'claude' }, deps)

    const otherHostDeps = makeDeps({ controlStore: { ...deps.controlStore, hostname: () => 'other-host' } })
    let thrown: unknown
    try {
      await startBackgroundRun({ issue: 42, agent: 'claude' }, otherHostDeps)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ControllerConflictError)
    // Code review, round 2, MINOR: the message must name the recorded run's
    // real host ('test-host', where the first start actually ran) — never
    // the composite `background:<host>:<pid>` ownerId string.
    expect((thrown as Error).message).toContain("host 'test-host'")
    expect((thrown as Error).message).not.toContain('background:')
    expect(spawnCalls).toHaveLength(1)
  })

  it('refuses before launching anything on a host this driver cannot supervise', async () => {
    const deps = makeDeps({ checkHostSupervisionCapability: () => ({ supported: false, reason: 'no ps here' }) })

    await expect(startBackgroundRun({ issue: 42, agent: 'claude' }, deps)).rejects.toThrow(BackgroundUnsupportedError)
    expect(spawnCalls).toHaveLength(0)
    expect(readCurrentOwnership(deps.controlStore, 42).epoch).toBe(0)
  })

  it('creates the per-task loop log file the child inherits stdio into', async () => {
    const deps = makeDeps()
    const handle = await startBackgroundRun({ issue: 7, agent: 'claude' }, deps)
    expect(existsSync(handle.logPath)).toBe(true)
    expect(readFileSync(handle.logPath, 'utf8')).toBe('')
  })
})
