import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONFIG_REFERENCE } from '@attalabs/vinaya-sources'
import { loadConfigChecked, resolveTaskRunner, type VinayaConfig } from '../src/lib/config.js'
import { cancelDevReviewLoop, taskFromPrBody } from '../src/lib/dev-review-loop.js'
import { readDriverLock, readPauseState, writeDriverLock } from '../src/lib/dev-review-loop/pause-resume.js'
import { runnerReadingFor } from '../src/lib/task-status.js'
import { runTask, type RunTaskDeps } from '../src/lib/task-run.js'
import {
  ENGINE_FALLBACK_NOTICE,
  readTaskRunner,
  recordTaskRunner,
  taskRunnerRecordPath
} from '../src/lib/task-run-engine.js'
import { createTaskCancelHandler } from '../src/lib/task-tools/cancel.js'
import { resumeContinuation } from '../src/lib/task-tools/resume.js'
import { makeWorld, runLoopInProcess, withWorldEnv, type RoleOutcome } from './lib/dev-review-loop-harness.js'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'runner-repo-default-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

/** Loads the config `task run` would load from `cwd`, through the same checked loader. */
function configFrom(cwd: string): VinayaConfig | null {
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    const loaded = loadConfigChecked()
    if (!loaded.ok) throw new Error(`${loaded.path}: ${loaded.error}`)
    return loaded.config
  } finally {
    process.chdir(previous)
  }
}

/** This repository's config with its `runner` key removed, written as a repository of its own. */
function configWithoutRunner(): VinayaConfig | null {
  const dir = root()
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'vinaya.config.json'), 'utf8')) as Record<string, unknown>
  delete raw.runner
  writeFileSync(join(dir, 'vinaya.config.json'), `${JSON.stringify(raw, null, 2)}\n`)
  return configFrom(dir)
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

describe('the runner this repository configures', () => {
  it('resolves atta-engine from this repository, standalone with no runner key, and standalone when selected', () => {
    const repo = configFrom(REPO_ROOT)
    expect(repo?.runner).toBe('atta-engine')
    expect(resolveTaskRunner(undefined, repo)).toBe('atta-engine')
    expect(resolveTaskRunner(undefined, configWithoutRunner())).toBe('standalone')
    expect(resolveTaskRunner(undefined, null)).toBe('standalone')
    expect(resolveTaskRunner('standalone', repo)).toBe('standalone')
    expect(resolveTaskRunner(undefined, { ...repo, runner: 'standalone' })).toBe('standalone')
  })

  it('records atta-engine as the runner a run started in this repository used', async () => {
    const runtime = root()
    const repo = configFrom(REPO_ROOT)
    const result = await runTask(
      { issue: 42, agent: 'claude' },
      fixtureDeps({
        runnerConfig: () => repo,
        recordRunner: (issue, runner) => recordTaskRunner(issue, runner, runtime),
        devReviewLoop: async () => {
          throw new Error('a run started in this repository must not take the standalone loop')
        },
        engine: { scriptPath: () => '/runner.ts', exists: () => true, spawn: async () => 0, notice: () => {} }
      })
    )
    expect('exitCode' in result && result.exitCode).toBe(0)
    expect(readTaskRunner(42, runtime)).toBe('atta-engine')
  })
})

describe('a run with no recorded runner', () => {
  it('routes status and resume to standalone although this repository configures atta-engine', () => {
    expect(configFrom(REPO_ROOT)?.runner).toBe('atta-engine')
    const runtime = root()
    expect(Bun.file(taskRunnerRecordPath(9, runtime)).size).toBe(0)
    expect(readTaskRunner(9, runtime)).toBe('standalone')
    expect(runnerReadingFor(9, runtime)).toEqual({ runner: 'standalone', engine: null })
    const target = { agent: 'claude' as const, issue: 9, branch: 'task/demo/1' }
    expect(resumeContinuation({ ...target, pr: 70 }, readTaskRunner(9, runtime), 'vinaya')).toEqual({
      command: 'vinaya',
      argv: ['dev-review-loop', '--resume', '70', '--agent', 'claude']
    })
    expect(resumeContinuation({ ...target, pr: null }, readTaskRunner(9, runtime), 'vinaya').command).toBe('vinaya')
  })

  it('routes cancel to standalone: it never waits on an Engine run behind a live driver lock', async () => {
    expect(configFrom(REPO_ROOT)?.runner).toBe('atta-engine')
    const escalate: RoleOutcome = {
      findings: '',
      report: 'ESCALATE: authority\nSUMMARY: needs a call nobody made.\n',
      objectives: null,
      sessionId: 'rev-session-1'
    }
    const world = makeWorld({ roleOutcomes: { 1: { reviewer: escalate } } })
    await runLoopInProcess(world)
    world.rulings = ['Cancel it.']
    world.rulingOrdinal = 1
    world.rulingAuthor = 'principal'
    expect(Bun.file(taskRunnerRecordPath(world.task, world.runtimeDir)).size).toBe(0)
    // A driver lock whose pid reads as alive: the Engine route would wait for that run to end.
    const lock = readDriverLock(world.runtimeDir, world.task)
    writeDriverLock(world.runtimeDir, world.task, {
      ...(lock ?? { startedAt: new Date().toISOString(), host: hostname() }),
      pid: process.pid
    } as NonNullable<typeof lock>)
    const livenessReads: number[] = []
    const handler = createTaskCancelHandler({
      runtimeDir: () => world.runtimeDir,
      resolveIssueForRef: () => world.task,
      fetchRulings: () => [...world.rulings],
      fetchNewestRulingOrdinal: () => world.rulingOrdinal,
      fetchIssueRulings: () => [...world.rulings],
      fetchNewestIssueRulingOrdinal: () => world.rulingOrdinal,
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
      runner: readTaskRunner,
      isPidAlive: (pid) => {
        livenessReads.push(pid)
        return true
      },
      engineStopTimeoutMs: 50
    })
    // A dispatched session's spool would take the cancel's Log line away from this world's folder.
    const spool = process.env.VINAYA_LOG_SPOOL_DIR
    delete process.env.VINAYA_LOG_SPOOL_DIR
    try {
      const result = await handler(
        { task: { issue: world.task }, reason: 'the Principal cancelled it' },
        { caller: { id: 'operator-1' } }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.result.outcome).not.toBe('pending')
    } finally {
      if (spool !== undefined) process.env.VINAYA_LOG_SPOOL_DIR = spool
    }
    expect(livenessReads).toEqual([])
  }, 60_000)
})

describe('the config reference runner entry', () => {
  it('states the standalone default and the one fallback notice task run prints', () => {
    const entry = CONFIG_REFERENCE.find((field) => field.key === 'runner')
    const text = entry?.semantics.join('\n') ?? ''
    expect(text).toContain('The default is `standalone`')
    expect(text).toContain(ENGINE_FALLBACK_NOTICE)
    expect(text).toContain('A run with no recorded runner')
  })
})
