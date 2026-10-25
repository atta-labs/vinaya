import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  type ControlStoreDeps,
  defaultControlStoreDeps,
  readEffect,
  taskToolError,
  writeEffect
} from '@attalabs/aeg-core'
import { COMMANDS } from '@attalabs/vinaya-sources'
import { parseFlags, rollbackFlagConflict } from '../src/commands/task-run.js'
import {
  BackendRollbackRefusedError,
  type BackendRollbackDeps,
  endEngineRunThrough,
  readRollbackRehearsals,
  reconcileEffectOnForge,
  rollbackRehearsalPath,
  terminateAndRestart
} from '../src/lib/backend-rollback.js'
/** The configuration a run reads its runner from. */
type VinayaConfig = NonNullable<ReturnType<NonNullable<RunTaskDeps['runnerConfig']>>>
import { writeDriverLock, writePauseState } from '../src/lib/dev-review-loop/pause-resume.js'
import type { EffectIdentity } from '../src/lib/effects.js'
import { CrossRunnerRefusedError, runTask, type RunTaskDeps } from '../src/lib/task-run.js'
import {
  crossRunnerRefusal,
  crossRunnerRefusalReason,
  crossRunnerRefusalText,
  readTaskRunner,
  recordTaskRunner
} from '../src/lib/task-run-engine.js'

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'backend-rollback-'))
  roots.push(value)
  return value
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

const TASK = 42
/** A pid no process holds. */
const EXITED_PID = 2 ** 22 + 1

function fixtureDeps(overrides: Partial<RunTaskDeps> = {}): RunTaskDeps {
  return {
    prepareTask: async () => ({ issue: TASK }) as Awaited<ReturnType<RunTaskDeps['prepareTask']>>,
    prepareIssueTask: async () => ({ issue: TASK }) as Awaited<ReturnType<RunTaskDeps['prepareIssueTask']>>,
    assembleAndRenderBrief: async () => {
      throw new Error('unexpected render')
    },
    assembleAndRenderBriefForIssue: async () => {
      throw new Error('unexpected render')
    },
    developerBranchFor: () => `task/issue-${TASK}`,
    findOpenPrForBranch: () => null,
    isDriverAlive: () => false,
    hasPauseState: () => false,
    resolveModelForDispatch: () => undefined,
    devReviewLoop: async () => ({ task: TASK, prNumber: 7, finalDecision: { type: 'publish' } }),
    resolveRepo: async () => null,
    assignIssue: () => {},
    runnerConfig: () => null,
    ...overrides
  }
}

const identity = (round: number): EffectIdentity => ({
  operation: 'pr-comment',
  target: 'pr:7',
  inputVersion: round,
  payloadDigest: `digest-${round}`
})

/** Records an effect at `status`, as an interrupted or fenced write leaves it. */
function recordEffect(store: ControlStoreDeps, key: string, round: number, status: 'started' | 'uncertain') {
  const owned = acquireOwnership(store, TASK, 'fixture')
  if (!owned.acquired) throw new Error('fixture: no epoch')
  writeEffect(store, TASK, owned.epoch, key, { ...identity(round), status, recordedAt: new Date().toISOString() })
}

/** The procedure's deps over one runtime directory, the Engine run recorded and ended by a stand-in cancel. */
function rollbackWorld(overrides: Partial<BackendRollbackDeps> = {}) {
  const runtimeDir = root()
  const controlStore = defaultControlStoreDeps(() => join(runtimeDir, 'tasks-execution'))
  recordTaskRunner(TASK, 'atta-engine', runtimeDir)
  const steps: string[] = []
  const deps: BackendRollbackDeps = {
    runtimeDir,
    controlStore,
    readRunner: (task) => readTaskRunner(task, runtimeDir),
    endEngineRun: async () => {
      steps.push('end')
      return { action: 'cancelled', fencedEffectKeys: [] }
    },
    reconcile: () => ({ outcome: 'absent' }),
    recordRunner: (task, runner) => {
      steps.push(`record:${runner}`)
      recordTaskRunner(task, runner, runtimeDir)
    },
    startStandalone: async () => {
      steps.push('start')
      return { terminalState: 'publish' }
    },
    ...overrides
  }
  return { runtimeDir, controlStore, steps, deps }
}

describe('the configured runner switch', () => {
  it('starts and records a new run on standalone once the configured runner is switched from atta-engine', async () => {
    const runtimeDir = root()
    const recordRunner = (issue: number, runner: 'standalone' | 'atta-engine') =>
      recordTaskRunner(issue, runner, runtimeDir)
    const started: string[] = []
    const deps = (config: VinayaConfig) =>
      fixtureDeps({
        runnerConfig: () => config,
        recordRunner,
        devReviewLoop: async () => {
          started.push('standalone')
          return { task: TASK, prNumber: 7, finalDecision: { type: 'publish' } }
        },
        engine: {
          scriptPath: () => '/runner.ts',
          exists: () => true,
          spawn: async () => {
            started.push('atta-engine')
            return 0
          },
          notice: () => {}
        }
      })
    await runTask({ issue: TASK, agent: 'claude' }, deps({ runner: 'atta-engine' } as VinayaConfig))
    expect(readTaskRunner(TASK, runtimeDir)).toBe('atta-engine')
    await runTask({ issue: TASK, agent: 'claude' }, deps({ runner: 'standalone' } as VinayaConfig))
    expect(started).toEqual(['atta-engine', 'standalone'])
    expect(readTaskRunner(TASK, runtimeDir)).toBe('standalone')
  })
})

describe('the typed cross-runner refusal', () => {
  it('names the recorded and the requested runner, and keeps the text both runners print', async () => {
    const runtimeDir = root()
    expect(crossRunnerRefusalReason(TASK, 'standalone', runtimeDir)).toBeNull()
    expect(crossRunnerRefusalReason(TASK, 'atta-engine', runtimeDir)).toEqual({
      code: 'recorded_on_another_runner',
      task: TASK,
      recorded: 'standalone',
      requested: 'atta-engine'
    })
    recordTaskRunner(TASK, 'atta-engine', runtimeDir)
    const reason = crossRunnerRefusalReason(TASK, 'standalone', runtimeDir)
    expect(reason).toEqual({
      code: 'recorded_on_another_runner',
      task: TASK,
      recorded: 'atta-engine',
      requested: 'standalone'
    })
    // The text the standalone loop, the Engine runner and its lifecycle print, word for word.
    const text =
      "task 42's paused run was recorded on the atta-engine runner, and the standalone runner never continues another runner's run — resume it on atta-engine."
    expect(crossRunnerRefusal(TASK, 'standalone', runtimeDir)).toBe(text)
    expect(reason && crossRunnerRefusalText(reason)).toBe(text)
    expect(crossRunnerRefusal(TASK, 'atta-engine', runtimeDir)).toBeNull()
  })

  it('refuses an Engine run resumed on standalone and a standalone run resumed on the Engine, typed', async () => {
    for (const [recorded, requested] of [
      ['atta-engine', 'standalone'],
      ['standalone', 'atta-engine']
    ] as const) {
      const runtimeDir = root()
      recordTaskRunner(TASK, recorded, runtimeDir)
      let starts = 0
      const refusal = await runTask(
        { issue: TASK, agent: 'claude', runner: requested },
        fixtureDeps({
          hasPauseState: () => true,
          crossRunnerRefusalReason: (issue, runner) => crossRunnerRefusalReason(issue, runner, runtimeDir),
          devReviewLoop: async () => {
            starts += 1
            return { task: TASK, prNumber: 7, finalDecision: { type: 'publish' } }
          },
          engine: {
            scriptPath: () => '/runner.ts',
            exists: () => true,
            spawn: async () => {
              starts += 1
              return 0
            },
            notice: () => {}
          }
        })
      ).catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(CrossRunnerRefusedError)
      expect((refusal as CrossRunnerRefusedError).reason).toEqual({
        code: 'recorded_on_another_runner',
        task: TASK,
        recorded,
        requested
      })
      expect((refusal as Error).message).toBe(
        `runTask: task ${TASK}'s paused run was recorded on the ${recorded} runner, and the ${requested} runner never continues another runner's run — resume it on ${recorded}.`
      )
      expect(starts).toBe(0)
    }
  })
})

describe('the terminate-and-restart procedure', () => {
  it('refuses a task whose recorded runner is not atta-engine, before anything runs or is recorded', async () => {
    const { runtimeDir, steps, deps } = rollbackWorld()
    recordTaskRunner(TASK, 'standalone', runtimeDir)
    const refusal = await terminateAndRestart(TASK, deps).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(BackendRollbackRefusedError)
    expect((refusal as BackendRollbackRefusedError).reason).toEqual({
      code: 'not_engine_run',
      task: TASK,
      recorded: 'standalone'
    })
    expect(steps).toEqual([])
    expect(existsSync(rollbackRehearsalPath(TASK, runtimeDir))).toBe(false)
  })

  it('ends the Engine run, reconciles by identity, then records and starts standalone, keeping the record', async () => {
    const { runtimeDir, controlStore, steps, deps } = rollbackWorld({
      reconcile: (seen) =>
        seen.inputVersion === 1 ? { outcome: 'confirmed', url: 'https://example.com/c/1' } : { outcome: 'absent' }
    })
    recordEffect(controlStore, 'landed', 1, 'uncertain')
    recordEffect(controlStore, 'missing', 2, 'started')
    const record = await terminateAndRestart(TASK, deps)
    expect(steps).toEqual(['end', 'record:standalone', 'start'])
    // A landed effect is verified, never repeated; a missing one is started again, for the restart to complete.
    const landed = readEffect(controlStore, TASK, 'landed')
    const missing = readEffect(controlStore, TASK, 'missing')
    expect(landed.status === 'ok' && [landed.value.status, landed.value.url]).toEqual([
      'verified',
      'https://example.com/c/1'
    ])
    expect(missing.status === 'ok' && missing.value.status).toBe('started')
    expect(record).toMatchObject({
      schemaVersion: 1,
      task: TASK,
      recordedRunner: 'atta-engine',
      action: 'cancelled',
      reconciledEffects: [
        { key: 'landed', identity: identity(1), found: 'uncertain', outcome: 'confirmed' },
        { key: 'missing', identity: identity(2), found: 'started', outcome: 'absent' }
      ],
      restarted: { runner: 'standalone', terminalState: 'publish' },
      refusal: null
    })
    expect(readTaskRunner(TASK, runtimeDir)).toBe('standalone')
    // The record outlives the run, and a second rehearsal is added beside it.
    recordTaskRunner(TASK, 'atta-engine', runtimeDir)
    await terminateAndRestart(TASK, deps)
    expect(readRollbackRehearsals(TASK, runtimeDir)).toHaveLength(2)
    expect(readRollbackRehearsals(TASK, runtimeDir)[0]).toEqual(record)
  })

  it('refuses to restart while an effect stays ambiguous, never replaying it, and keeps the refused rehearsal', async () => {
    const { runtimeDir, controlStore, steps, deps } = rollbackWorld({
      reconcile: () => ({ outcome: 'ambiguous', reason: 'the forge read failed' })
    })
    recordEffect(controlStore, 'unknown', 1, 'uncertain')
    const refusal = await terminateAndRestart(TASK, deps).catch((error: unknown) => error)
    expect((refusal as BackendRollbackRefusedError).reason).toEqual({
      code: 'effect_ambiguous',
      task: TASK,
      keys: ['unknown'],
      detail: 'the forge read failed'
    })
    expect(steps).toEqual(['end'])
    const effect = readEffect(controlStore, TASK, 'unknown')
    expect(effect.status === 'ok' && effect.value.status).toBe('uncertain')
    expect(readTaskRunner(TASK, runtimeDir)).toBe('atta-engine')
    expect(readRollbackRehearsals(TASK, runtimeDir)).toEqual([
      expect.objectContaining({ restarted: null, refusal: expect.objectContaining({ code: 'effect_ambiguous' }) })
    ])
  })

  it('never starts the standalone run while the Engine driver is still live', async () => {
    const { runtimeDir, steps, deps } = rollbackWorld()
    writeDriverLock(runtimeDir, TASK, { pid: process.pid, startedAt: new Date().toISOString() })
    const refusal = await terminateAndRestart(TASK, deps).catch((error: unknown) => error)
    expect((refusal as BackendRollbackRefusedError).reason).toEqual({
      code: 'engine_running',
      task: TASK,
      pid: process.pid
    })
    expect(steps).toEqual(['end'])
  })

  it('reports a refused cancel as the refusal, and starts nothing', async () => {
    const { runtimeDir, steps, deps } = rollbackWorld({
      endEngineRun: async () => {
        throw new Error('PR 7 carries no Principal ruling comment yet')
      }
    })
    const refusal = await terminateAndRestart(TASK, deps).catch((error: unknown) => error)
    expect((refusal as BackendRollbackRefusedError).reason).toEqual({
      code: 'cancel_refused',
      task: TASK,
      detail: 'PR 7 carries no Principal ruling comment yet'
    })
    expect(steps).toEqual([])
    expect(readRollbackRehearsals(TASK, runtimeDir)).toHaveLength(1)
  })
})

describe('ending the Engine run through public run control', () => {
  it('cancels a held pause through the shared cancel, and fences a halted run with no pause held', async () => {
    const runtimeDir = root()
    const controlStore = defaultControlStoreDeps(() => join(runtimeDir, 'tasks-execution'))
    const cancels: unknown[] = []
    const end = endEngineRunThrough(
      async (input) => {
        cancels.push(input)
        return {
          ok: true,
          result: {
            task: TASK,
            pr: 7,
            escalationId: 'e',
            outcome: 'uncertain',
            authenticatedBy: 'principal',
            authenticatedFrom: '7-1',
            fencedEffectKeys: ['in-flight']
          }
        }
      },
      runtimeDir,
      controlStore
    )
    // Halted with no pause held and no live driver: its started effects are fenced as a cancel fences them.
    recordEffect(controlStore, 'in-flight', 1, 'started')
    writeDriverLock(runtimeDir, TASK, { pid: EXITED_PID, startedAt: new Date().toISOString() })
    expect(await end(TASK)).toEqual({ action: 'halted', fencedEffectKeys: ['in-flight'] })
    expect(cancels).toEqual([])
    // A live driver holding no pause is refused, never signalled.
    writeDriverLock(runtimeDir, TASK, { pid: process.pid, startedAt: new Date().toISOString() })
    await expect(end(TASK)).rejects.toThrow(`task ${TASK}'s Engine driver (pid ${process.pid}) is still running`)
    // A held pause goes through the shared cancel.
    writePauseState(runtimeDir, {
      task: TASK,
      round: 1,
      head: 'a'.repeat(40),
      reason: 'escalation',
      prNumber: 7,
      branch: `task/issue-${TASK}`,
      pausedAt: new Date().toISOString()
    })
    expect(await end(TASK)).toEqual({ action: 'cancelled', fencedEffectKeys: ['in-flight'] })
    expect(cancels).toEqual([
      expect.objectContaining({ task: { issue: TASK }, reason: expect.stringContaining('terminate and restart') })
    ])
  })

  it('reports the shared cancel’s refusal as a typed cancel refusal', async () => {
    const runtimeDir = root()
    writePauseState(runtimeDir, {
      task: TASK,
      round: 1,
      head: 'a'.repeat(40),
      reason: 'escalation',
      prNumber: 7,
      branch: `task/issue-${TASK}`,
      pausedAt: new Date().toISOString()
    })
    const end = endEngineRunThrough(
      async () => ({ ok: false, error: taskToolError('authority', 'PR 7 carries no Principal ruling comment yet') }),
      runtimeDir,
      defaultControlStoreDeps(() => join(runtimeDir, 'tasks-execution'))
    )
    const refusal = await end(TASK).catch((error: unknown) => error)
    expect((refusal as BackendRollbackRefusedError).reason).toEqual({
      code: 'cancel_refused',
      task: TASK,
      detail: 'PR 7 carries no Principal ruling comment yet'
    })
  })

  it('leaves an effect no forge read reconciles ambiguous', () => {
    expect(reconcileEffectOnForge({ ...identity(1), operation: 'branch-push', target: 'scope:42' })).toEqual({
      outcome: 'ambiguous',
      reason: "no forge read reconciles a 'branch-push' effect on 'scope:42'"
    })
  })
})

describe('task run --rollback', () => {
  it('runs the procedure around a fresh standalone run and returns that run', async () => {
    const { runtimeDir, deps } = rollbackWorld()
    const loops: unknown[] = []
    const result = await runTask(
      { issue: TASK, agent: 'codex', model: 'm1', rollback: true },
      fixtureDeps({
        resolveModelForDispatch: (_agent, _issue, explicit) => explicit,
        recordRunner: (issue, runner) => recordTaskRunner(issue, runner, runtimeDir),
        devReviewLoop: async (input) => {
          loops.push(input)
          return { task: TASK, prNumber: 7, finalDecision: { type: 'publish' } }
        },
        backendRollback: (issue, wiring) => terminateAndRestart(issue, { ...deps, ...wiring })
      })
    )
    expect(loops).toEqual([{ task: TASK, agent: 'codex', model: 'm1' }])
    expect(readTaskRunner(TASK, runtimeDir)).toBe('standalone')
    expect(result).toMatchObject({ task: TASK, prNumber: 7, finalDecision: { type: 'publish' } })
    expect(readRollbackRehearsals(TASK, runtimeDir)).toEqual([
      expect.objectContaining({ restarted: { runner: 'standalone', terminalState: 'publish' } })
    ])
  })

  it('parses --rollback, refuses it beside --runner, --widen-surface or --background, and documents the flag', () => {
    expect(parseFlags(['--agent', 'claude', '--rollback']).rollback).toBe(true)
    expect(rollbackFlagConflict(parseFlags(['--agent', 'claude', '--rollback']))).toBeNull()
    expect(rollbackFlagConflict(parseFlags(['--rollback', '--runner', 'standalone', '--background']))).toBe(
      '--rollback restarts on the standalone runner in this process and takes no --runner, --background.'
    )
    const flag = COMMANDS.find((command) => command.name === 'task run')?.flags?.find((f) => f.flag === '--rollback')
    expect(flag?.description).toContain('terminate-and-restart procedure')
    expect(flag?.description).toContain('Refuses a task whose recorded runner is not `atta-engine`')
  })
})
