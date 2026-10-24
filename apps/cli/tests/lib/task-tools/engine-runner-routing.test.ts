import { afterEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireOwnership, defaultControlStoreDeps, readEffect, readResolution, writeEffect } from '@attalabs/aeg-core'
import { cancelDevReviewLoop, taskFromPrBody } from '../../../src/lib/dev-review-loop.js'
import {
  escalationIdFor,
  isDriverPidAlive,
  readDriverLock,
  readPauseState,
  writeDriverLock
} from '../../../src/lib/dev-review-loop/pause-resume.js'
import { engineRunNote, runnerReadingFor } from '../../../src/lib/task-status.js'
import { runTask, type RunTaskDeps } from '../../../src/lib/task-run.js'
import {
  crossRunnerRefusal,
  engineCancellationRequested,
  engineRunDirectory,
  engineRunnerScriptPath,
  readTaskRunner,
  recordTaskRunner,
  taskRunnerRecordPath
} from '../../../src/lib/task-run-engine.js'
import { createTaskCancelHandler } from '../../../src/lib/task-tools/cancel.js'
import { readEscalationPacket } from '../../../src/lib/task-tools/read.js'
import { resumeContinuation } from '../../../src/lib/task-tools/resume.js'
import { claimResume, liveResumeDeps } from '../../../../../processes/vinaya/bin/run-lifecycle.js'
import {
  makeWorld,
  outboxLines,
  runLoopInProcess,
  withWorldEnv,
  type LoopWorld,
  type RoleOutcome
} from '../dev-review-loop-harness.js'

const roots: string[] = []
const children: number[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'engine-runner-routing-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

const ESCALATE_REVIEWER: RoleOutcome = {
  findings: '',
  report: 'ESCALATE: authority\nSUMMARY: needs a call nobody made.\n',
  objectives: null,
  sessionId: 'rev-session-1'
}

/** A standalone run paused for the Principal at round 1, with a ruling posted since. */
async function pausedWorld(): Promise<LoopWorld> {
  const world = makeWorld({ roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } } })
  await runLoopInProcess(world)
  world.rulings = ['Cancel it.']
  world.rulingOrdinal = 1
  world.rulingAuthor = 'principal'
  return world
}

function fixtureDeps(overrides: Partial<RunTaskDeps> = {}): RunTaskDeps {
  return {
    prepareTask: async () => ({ issue: 42 }) as Awaited<ReturnType<RunTaskDeps['prepareTask']>>,
    prepareIssueTask: async () => ({ issue: 42 }) as Awaited<ReturnType<RunTaskDeps['prepareIssueTask']>>,
    assembleAndRenderBrief: async () => {
      throw new Error('unexpected render')
    },
    assembleAndRenderBriefForIssue: async () => {
      throw new Error('unexpected render')
    },
    developerBranchFor: () => 'task/issue-42',
    findOpenPrForBranch: () => null,
    isDriverAlive: () => false,
    hasPauseState: () => false,
    resolveModelForDispatch: () => undefined,
    devReviewLoop: async () => ({ task: 42, prNumber: 7, finalDecision: { type: 'publish' } }),
    resolveRepo: async () => null,
    assignIssue: () => {},
    runnerConfig: () => null,
    ...overrides
  }
}

/**
 * A stand-in for a live Engine run: it launches one stub agent through the Engine's own child reaper and, on the
 * signal that halts a run, ends that agent's process group before it exits, as the Engine runner does.
 */
async function startStubEngine(dir: string): Promise<{ engine: number; agent: number }> {
  const lifecycle = join(import.meta.dir, '../../../../../processes/vinaya/bin/run-lifecycle.ts')
  const script = join(dir, 'stub-engine.ts')
  const agentFile = join(dir, 'agent.pid')
  writeFileSync(
    script,
    `
      import { writeFileSync } from 'node:fs'
      import { createChildReaper, onShutdownSignals } from ${JSON.stringify(lifecycle)}
      const reaper = createChildReaper()
      const agent = reaper.spawnFn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {})
      writeFileSync(${JSON.stringify(agentFile)}, String(agent.pid))
      onShutdownSignals(async () => {
        await reaper.reap(200)
        process.exit(143)
      })
      setInterval(() => {}, 1000)
    `
  )
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  children.push(child.pid!)
  for (let i = 0; i < 200 && !existsSync(agentFile); i++) await new Promise((r) => setTimeout(r, 50))
  const agent = Number(readFileSync(agentFile, 'utf8'))
  children.push(agent)
  return { engine: child.pid!, agent }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the recorded runner', () => {
  it('reads a run with no recorded runner as standalone, and keeps the newest record', async () => {
    const runtime = root()
    expect(readTaskRunner(17, runtime)).toBe('standalone')
    recordTaskRunner(17, 'atta-engine', runtime, () => new Date('2026-01-02T03:04:05.000Z'))
    expect(readTaskRunner(17, runtime)).toBe('atta-engine')
    expect(await Bun.file(taskRunnerRecordPath(17, runtime)).json()).toEqual({
      schemaVersion: 1,
      runner: 'atta-engine',
      recordedAt: '2026-01-02T03:04:05.000Z'
    })
    recordTaskRunner(17, 'standalone', runtime)
    expect(readTaskRunner(17, runtime)).toBe('standalone')
  })

  it('task run records the runner it actually used: the Engine, a fallback to standalone, or standalone', async () => {
    const recorded: string[] = []
    const recordRunner = (_issue: number, runner: string) => void recorded.push(runner)
    const engine = (exists: boolean) => ({
      scriptPath: () => '/runner.ts',
      exists: () => exists,
      spawn: async () => 0,
      notice: () => {}
    })
    await runTask(
      { issue: 42, agent: 'claude', runner: 'atta-engine' },
      fixtureDeps({ recordRunner, engine: engine(true) })
    )
    await runTask(
      { issue: 42, agent: 'claude', runner: 'atta-engine' },
      fixtureDeps({ recordRunner, engine: engine(false) })
    )
    await runTask({ issue: 42, agent: 'claude', runner: 'standalone' }, fixtureDeps({ recordRunner }))
    expect(recorded).toEqual(['atta-engine', 'standalone', 'standalone'])
  })
})

describe('task_start', () => {
  it('starts each runner on its own path and refuses a held pause the other runner recorded', async () => {
    const runtime = root()
    let standaloneStarts = 0
    let engineStarts = 0
    const deps = (pause: boolean) =>
      fixtureDeps({
        hasPauseState: () => pause,
        crossRunnerRefusal: (issue, runner) => crossRunnerRefusal(issue, runner, runtime),
        devReviewLoop: async () => {
          standaloneStarts += 1
          return { task: 42, prNumber: 7, finalDecision: { type: 'publish' } }
        },
        engine: {
          scriptPath: () => '/runner.ts',
          exists: () => true,
          spawn: async () => {
            engineStarts += 1
            return 0
          },
          notice: () => {}
        }
      })
    await runTask({ issue: 42, agent: 'claude', runner: 'standalone' }, deps(false))
    await runTask({ issue: 42, agent: 'claude', runner: 'atta-engine' }, deps(false))
    expect([standaloneStarts, engineStarts]).toEqual([1, 1])
    // A legacy pause carries no record: the standalone runner holds it.
    await expect(runTask({ issue: 42, agent: 'claude', runner: 'atta-engine' }, deps(true))).rejects.toThrow(
      'recorded on the standalone runner'
    )
    recordTaskRunner(42, 'atta-engine', runtime)
    await expect(runTask({ issue: 42, agent: 'claude', runner: 'standalone' }, deps(true))).rejects.toThrow(
      'recorded on the atta-engine runner'
    )
    expect([standaloneStarts, engineStarts]).toEqual([1, 1])
  })
})

describe('task_status', () => {
  it('reads an Engine run directory, its checkpoint and its lock, and nothing of the Engine for standalone', () => {
    const runtime = root()
    expect(runnerReadingFor(5, runtime)).toEqual({ runner: 'standalone', engine: null })
    expect(engineRunNote(null)).toBe('')
    recordTaskRunner(5, 'atta-engine', runtime)
    expect(runnerReadingFor(5, runtime)).toEqual({
      runner: 'atta-engine',
      engine: { runDirectory: engineRunDirectory(5, runtime), checkpoint: false, lock: null }
    })
    mkdirSync(engineRunDirectory(5, runtime), { recursive: true })
    writeFileSync(join(engineRunDirectory(5, runtime), 'checkpoints.sqlite'), '')
    writeDriverLock(runtime, 5, { pid: process.pid, startedAt: new Date().toISOString(), host: hostname() } as never)
    const reading = runnerReadingFor(5, runtime)
    expect(reading.engine).toEqual({
      runDirectory: engineRunDirectory(5, runtime),
      checkpoint: true,
      lock: { pid: process.pid, alive: true }
    })
    expect(engineRunNote(reading.engine)).toBe(` · Engine run, checkpoint kept, lock pid ${process.pid}`)
  })
})

describe('task_escalation_read', () => {
  it('returns the escalation record for each runner, naming that runner’s own continuation', async () => {
    const world = await pausedWorld()
    const standalone = readEscalationPacket(world.runtimeDir, world.task)!
    expect(standalone.runIdentity).not.toBeNull()
    expect(standalone.permittedNextActions.at(-1)).toBe(`Or run: vinaya dev-review-loop --resume ${world.prNumber}`)
    recordTaskRunner(world.task, 'atta-engine', world.runtimeDir)
    const engine = readEscalationPacket(world.runtimeDir, world.task)!
    expect(engine.runIdentity).toEqual(standalone.runIdentity)
    expect(engine.inputVersions).toEqual(standalone.inputVersions)
    expect(engine.permittedNextActions.at(-1)).toBe(
      `Or run: bun ${engineRunnerScriptPath()} --resume ${world.prNumber} --agent claude`
    )
  })
})

describe('task_resume', () => {
  it('continues each runner’s halted run on that runner, through its pull request or else its task', () => {
    const target = { issue: 9, branch: 'task/x/9', agent: 'codex' as const, model: 'm1' }
    expect(resumeContinuation({ ...target, pr: 70 }, 'standalone', 'vinaya')).toEqual({
      command: 'vinaya',
      argv: ['dev-review-loop', '--resume', '70', '--agent', 'codex']
    })
    expect(resumeContinuation({ ...target, pr: null }, 'standalone', 'vinaya').argv.slice(0, 2)).toEqual([
      'task',
      'run'
    ])
    expect(resumeContinuation({ ...target, pr: 70 }, 'atta-engine', 'vinaya')).toEqual({
      command: 'bun',
      argv: [engineRunnerScriptPath(), '--resume', '70', '--agent', 'codex', '--model', 'm1']
    })
    expect(resumeContinuation({ ...target, pr: null }, 'atta-engine', 'vinaya')).toEqual({
      command: 'bun',
      argv: [engineRunnerScriptPath(), '--task', '9', '--agent', 'codex', '--model', 'm1']
    })
  })

  it('refuses a run paused on one runner when the other runner resumes it, naming the recorded runner', async () => {
    // Paused on the standalone runner: the Engine's resume refuses before it reads or consumes anything.
    const standalone = await pausedWorld()
    expect(() =>
      claimResume(
        standalone.runtimeDir,
        { pr: standalone.prNumber, agent: 'claude' },
        { ...liveResumeDeps, fetchPrBody: () => standalone.prBody, taskFromPrBody }
      )
    ).toThrow(`task ${standalone.task}'s paused run was recorded on the standalone runner`)
    // Paused on the Engine runner: the standalone loop's resume refuses it.
    const engine = await pausedWorld()
    recordTaskRunner(engine.task, 'atta-engine', engine.runtimeDir)
    await expect(runLoopInProcess(engine, { resumePr: engine.prNumber, agent: 'claude' })).rejects.toThrow(
      `task ${engine.task}'s paused run was recorded on the atta-engine runner`
    )
    // Neither refusal consumed the pause's decision.
    for (const world of [standalone, engine]) {
      const held = readPauseState(world.runtimeDir, world.task)!
      const resolution = readResolution(
        defaultControlStoreDeps(() => join(world.runtimeDir, 'tasks-execution')),
        world.task,
        held.escalationId ?? escalationIdFor(world.task, held.round, held.head)
      )
      expect(resolution.status).toBe('absent')
    }
  }, 60_000)
})

describe('task_cancel', () => {
  async function cancelThroughOperator(world: LoopWorld) {
    const controlStore = defaultControlStoreDeps(() => join(world.runtimeDir, 'tasks-execution'))
    const owned = acquireOwnership(controlStore, world.task, 'fixture-effect')
    if (!owned.acquired) throw new Error('fixture: no epoch')
    writeEffect(controlStore, world.task, owned.epoch, 'in-flight-comment', {
      operation: 'pr-comment',
      target: `pr:${world.prNumber}`,
      inputVersion: 1,
      payloadDigest: 'digest-1',
      status: 'started',
      recordedAt: '2026-01-01T00:00:00.000Z'
    })
    const handler = createTaskCancelHandler({
      runtimeDir: () => world.runtimeDir,
      resolveIssueForRef: () => world.task,
      fetchRulings: () => [...world.rulings],
      fetchNewestRulingOrdinal: () => world.rulingOrdinal,
      fetchIssueRulings: () => [...world.rulings],
      fetchNewestIssueRulingOrdinal: () => world.rulingOrdinal,
      // The one cancel both runners share, over this world's records.
      cancelDevReviewLoop: (input) =>
        withWorldEnv(world, () =>
          cancelDevReviewLoop(input, {
            fetchPrBody: () => world.prBody,
            taskFromPrBody,
            readPauseState,
            fetchRulings: () => [...world.rulings],
            fetchNewestRulingOrdinal: () => world.rulingOrdinal,
            fetchNewestRulingAuthor: () => world.rulingAuthor,
            runtimeDir: () => world.runtimeDir,
            resolveRepo: async () => null,
            terminateInFlightLaunchesOnShutdown: () => {},
            sleep: (ms) => new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
          })
        ),
      hostname,
      log: () => {},
      runner: readTaskRunner
    })
    // A dispatched session's spool would take the cancel's Log line away from this world's folder.
    const spool = process.env.VINAYA_LOG_SPOOL_DIR
    delete process.env.VINAYA_LOG_SPOOL_DIR
    let result: Awaited<ReturnType<typeof handler>>
    try {
      result = await handler(
        { task: { issue: world.task }, reason: 'the Principal cancelled it' },
        {
          caller: { id: 'operator-1' }
        }
      )
    } finally {
      if (spool !== undefined) process.env.VINAYA_LOG_SPOOL_DIR = spool
    }
    const held = readPauseState(world.runtimeDir, world.task)!
    const escalationId = held.escalationId ?? escalationIdFor(world.task, held.round, held.head)
    return {
      result,
      resolution: readResolution(controlStore, world.task, escalationId),
      effect: readEffect(controlStore, world.task, 'in-flight-comment'),
      cancelled: outboxLines(world).filter((l) => l.kind === 'dev_review_loop' && l.event === 'cancelled')
    }
  }

  it('cancels a standalone run through the standalone cancel', async () => {
    const world = await pausedWorld()
    const lock = readDriverLock(world.runtimeDir, world.task)
    if (lock !== null) writeDriverLock(world.runtimeDir, world.task, { ...lock, pid: 2 ** 22 + 1 })
    const { result, resolution, effect, cancelled } = await cancelThroughOperator(world)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result).toMatchObject({ outcome: 'uncertain', fencedEffectKeys: ['in-flight-comment'] })
    expect(resolution.status === 'ok' && resolution.value.decision).toBe('cancel')
    expect(effect.status === 'ok' && effect.value.status).toBe('uncertain')
    expect(cancelled).toHaveLength(1)
    expect(engineCancellationRequested(world.task, world.runtimeDir)).toBe(false)
  }, 60_000)

  it('cancels an Engine run: consumes the resolution, fences started effects, and halts it with no agent left', async () => {
    const world = await pausedWorld()
    recordTaskRunner(world.task, 'atta-engine', world.runtimeDir)
    const stub = await startStubEngine(root())
    const lock = readDriverLock(world.runtimeDir, world.task)
    writeDriverLock(world.runtimeDir, world.task, {
      ...(lock ?? { startedAt: new Date().toISOString(), host: hostname() }),
      pid: stub.engine
    } as never)
    expect([alive(stub.engine), alive(stub.agent)]).toEqual([true, true])
    const { result, resolution, effect, cancelled } = await cancelThroughOperator(world)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result).toMatchObject({ outcome: 'uncertain', fencedEffectKeys: ['in-flight-comment'] })
    expect(resolution.status === 'ok' && resolution.value.decision).toBe('cancel')
    expect(effect.status === 'ok' && effect.value.status).toBe('uncertain')
    expect(cancelled).toHaveLength(1)
    // The run was told its halt is a cancel, and was halted: neither it nor its agent survives.
    expect(engineCancellationRequested(world.task, world.runtimeDir)).toBe(true)
    expect(isDriverPidAlive(stub.engine)).toBe(false)
    for (let i = 0; i < 50 && alive(stub.agent); i++) await new Promise((r) => setTimeout(r, 20))
    expect(alive(stub.agent)).toBe(false)
  }, 60_000)
})
