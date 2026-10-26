import { describe, expect, test } from 'bun:test'
import { recordedHandoff } from './handoff-fakes'
import { handoffHaltReason } from '../executing/log-events'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  buildReviewInputManifest,
  DEFAULT_REVIEW_POLICY,
  initialLoopState,
  objectivesVersion,
  type ReconstructedJournal,
  type ReviewInputManifest
} from '@attalabs/aeg-core'
import { createRunControl, type RunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { MemorySaver } from '@langchain/langgraph'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import {
  startProcessRun,
  type ActionRegistry,
  type ProcessAction,
  type ProcessRunOptions
} from '../../../harness/dev-process/engine-runtime/run-process'
import { DEFAULT_REVIEWER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../../../apps/cli/src/lib/dispatch'
import type { LaunchRecord, ParsedLaunch } from '../../../apps/cli/src/lib/dispatch'
import {
  DRIVER_HEARTBEAT_INTERVAL_MS,
  keepDriverLock,
  type DriverLockExit
} from '../../../apps/cli/src/lib/dev-review-loop/driver-lifecycle'
import { loopHistoryFromComments } from '../../../apps/cli/src/lib/dev-review-loop/journal-history'
import {
  acquireDriverLockAtomic,
  readDriverLock,
  readPauseState,
  writeDriverLock,
  writePauseState
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import {
  buildVerdictFromReview,
  latestHeldCleanVerdict,
  writeHeldVerdict
} from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { loopLogPathFor } from '../../../apps/cli/src/lib/loop-log'
import { parseReviewResult } from '../../../apps/cli/src/lib/review-result'
import { manifestDigest } from '../../../apps/cli/src/lib/review-result'
import {
  ACTION_BINDINGS,
  classifyGateResult,
  createRoleLaunchers,
  dispatchReviewers,
  EXIT_OPEN_PR,
  type TaskInput
} from '../executing/actions'
import {
  chooseStart,
  createChildReaper,
  liveStartTime,
  lockExitOf,
  recoverRun,
  revisionMovedLine,
  roleTimeouts,
  runIdentityOfTask,
  takeDriverLock,
  type RecoveryDeps
} from '../bin/run-lifecycle'
import {
  heldPullRequestConflictsLive,
  runEngine,
  type EngineLifecycleOptions,
  type EngineRunOptions,
  type RunTrace
} from '../bin/run-engine'

const loaded = loadProcess(resolve(import.meta.dir, '..'))
const repoRoot = resolve(import.meta.dir, '../../..')
const TASK = 7

// A stub login keeps the real role launcher from copying an operator's Codex credential into a test run.
const stubHome = mkdtempSync(join(tmpdir(), 'lifecycle-codex-home-'))
writeFileSync(join(stubHome, 'auth.json'), '{}\n')
process.env.CODEX_HOME = stubHome

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  for (let waited = 0; !done() && waited < ms; waited += 25) await sleep(25)
  if (!done()) throw new Error('timed out waiting')
}

// --- a stub run ------------------------------------------------------------------

type AgentName = 'claude' | 'codex'
const ROLE_STEP: Record<string, string> = {
  developer: 'develop',
  'code-reviewer': 'code-review',
  'security-reviewer': 'security-review'
}

/** The role a launch is for: Claude names its role's generated settings, Codex its home. */
function roleOfLaunch(agent: AgentName, args: string[], env: Record<string, string | undefined> | undefined): string {
  const dir =
    agent === 'claude'
      ? (args[args.indexOf('--settings') + 1] ?? '').split('/').at(-2)
      : (env?.CODEX_HOME ?? '').split('/').at(-1)
  return dir ?? ''
}

/** A child that reports `lines` and closes, or one that never closes until it is killed. */
function stubAgent(lines: string[], hang = false): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () => {
        if (hang) return
        setTimeout(() => {
          for (const line of lines) stdout?.(`${line}\n`)
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: { on: (_event, listener) => (stdout = listener as (chunk: string) => void) },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    // A real child closes after it is signalled, not while the signal is being sent.
    kill: () => {
      setTimeout(() => {
        for (const listener of closeListeners) listener(null)
      }, 0)
    }
  } as SpawnedProcessLike
}

const review = (role: string) =>
  JSON.stringify({
    reviewResult: {
      schemaVersion: 1,
      role,
      status: 'completed',
      headSha: 'abc',
      manifestDigest: 'd',
      summary: 'fine',
      findings: [],
      objectiveResults: []
    }
  })
const AGENT_LINES: Record<string, string[]> = {
  developer: ['{"type":"result"}'],
  'code-reviewer': [review('code-reviewer')],
  'security-reviewer': [review('security-reviewer')]
}

interface Scenario {
  agent?: AgentName
  /** Replaces the named action; the others exit zero. */
  actions?: Record<string, ProcessAction>
  control?: RunControl
  lifecycle?: EngineLifecycleOptions
  revision?: string
  /** Roles whose launch never ends by itself. */
  hang?: string[]
}

function stubRun(scenario: Scenario = {}, runtimeDir = mkdtempSync(join(tmpdir(), 'lifecycle-'))) {
  const agent = scenario.agent ?? 'claude'
  const calls: string[] = []
  const events: Array<{ kind: string; event: string; [field: string]: unknown }> = []
  const actionRuns: Record<string, number> = {}
  const spawns: string[] = []
  const actions: ActionRegistry = Object.fromEntries(
    Object.keys(ACTION_BINDINGS).map((name) => [
      name,
      async (context) => {
        actionRuns[context.nodeId] = (actionRuns[context.nodeId] ?? 0) + 1
        const replaced = scenario.actions?.[name]
        if (replaced) return replaced(context)
        if (name === 'vinaya.classify-gate-result') return classifyGateResult(context)
        if (name === 'vinaya.dispatch-reviewers') return dispatchReviewers()
        return { exitCode: 0 }
      }
    ])
  )
  const handoff = recordedHandoff()
  const options: EngineRunOptions = {
    args: { task: TASK, agent, dryRun: false },
    process: loaded,
    repoRoot,
    runtimeDir,
    loopId: 'lifecycle-test',
    taskInput: { branch: 'task/issue-7' } as TaskInput,
    handoffDeps: handoff.deps,
    actions,
    sink: {
      log: (event: unknown) => events.push(event as never),
      drain: async () => void calls.push('drain')
    },
    startHost: async () => ({ close: async () => void calls.push('host-close') }),
    devToolsContext: {} as never,
    control: scenario.control,
    out: (line) => calls.push(`out:${line}`),
    revision: scenario.revision ?? 'rev-a',
    lifecycle: { killGraceMs: 200, handleSignals: false, ...scenario.lifecycle },
    spawnFn: (_command, args, spawnOptions) => {
      const role = roleOfLaunch(agent, args, spawnOptions?.env)
      spawns.push(ROLE_STEP[role] as string)
      return stubAgent(AGENT_LINES[role] ?? [], scenario.hang?.includes(role))
    }
  }
  const driverLog = (): string => {
    const path = loopLogPathFor(null, TASK, runtimeDir)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  const trace = (path: string): RunTrace => JSON.parse(readFileSync(path, 'utf8')) as RunTrace
  return { options, calls, events, actionRuns, spawns, runtimeDir, driverLog, trace, handoff }
}

/** Halts the run from inside an action, then lets the action succeed. */
function haltThen(control: RunControl, reason: string): { exitCode: number } {
  control.halt(reason)
  return { exitCode: 0 }
}

const exitsOf = (events: Array<{ event: string }>) => events.filter((event) => event.event === 'driver_exited')

// --- one runner per task (the driver lock) ----------------------------------------

describe('one Engine runner per task', () => {
  test('a second runner for a task whose lock is held exits without dispatching, and names the holder', async () => {
    const run = stubRun()
    writeDriverLock(run.runtimeDir, TASK, { pid: 4242, startedAt: '2026-01-02T03:04:05.000Z', token: 'other' })
    run.options.lifecycle = { ...run.options.lifecycle, isPidAlive: (pid) => pid === 4242 }
    // The running driver's own trace is left as it is.
    const holderTrace = join(run.runtimeDir, 'engine-runs', String(TASK), 'trace.json')
    mkdirSync(dirname(holderTrace), { recursive: true })
    writeFileSync(holderTrace, '{"outcome":"running"}\n')
    const result = await runEngine(run.options)
    expect(readFileSync(holderTrace, 'utf8')).toBe('{"outcome":"running"}\n')
    expect(result.exitCode).toBe(1)
    expect(run.spawns).toEqual([])
    expect(Object.keys(run.actionRuns)).toEqual([])
    expect(run.calls.some((call) => call.includes('pid 4242') && call.includes('2026-01-02T03:04:05.000Z'))).toBe(true)
    expect(run.driverLog()).toContain('a driver is already running (pid 4242, started 2026-01-02T03:04:05.000Z)')
    expect(readDriverLock(run.runtimeDir, TASK)).toMatchObject({ pid: 4242, token: 'other' })
    const trace = run.trace(result.tracePath)
    expect(trace.outcome).toBe('refused')
    expect(trace.error).toContain('pid 4242')
    expect(exitsOf(run.events)).toEqual([])
  })

  test('the lock is an exclusive create: a lost race is refused when its winner is alive', () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-lock-'))
    expect(acquireDriverLockAtomic(root, TASK, { pid: 1, startedAt: 'then', token: 'a' })).toBe(true)
    const outcome = takeDriverLock(root, TASK, {
      pid: 2,
      now: () => new Date(0),
      isPidAlive: () => true,
      token: 'b',
      narrate: () => {}
    })
    expect(outcome).toMatchObject({ acquired: false, holder: { pid: 1 } })
  })

  test('a lock whose holder is gone is taken over, and the takeover is narrated', async () => {
    const run = stubRun()
    writeDriverLock(run.runtimeDir, TASK, { pid: 4243, startedAt: 'long ago', token: 'dead' })
    run.options.lifecycle = { ...run.options.lifecycle, isPidAlive: () => false }
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(0)
    expect(run.driverLog()).toContain(
      'driver lock names pid 4243 (started long ago), which is no longer alive — taking over'
    )
    expect(run.spawns).toEqual(['develop', 'code-review', 'security-review'])
  })

  test('the runner holds the lock under its own pid for as long as the run lasts', async () => {
    const held: unknown[] = []
    const run = stubRun({
      actions: {
        'harness.run-gates': () => {
          held.push(readDriverLock(run.runtimeDir, TASK))
          return { exitCode: 0 }
        }
      }
    })
    await runEngine(run.options)
    expect(held).toEqual([expect.objectContaining({ pid: process.pid })])
  })

  // A pause decision as the assess-round step reports it: recorded in the step's result, the run halted for it.
  const decided =
    (reason: string, control: RunControl): ProcessAction =>
    () => {
      control.halt(handoffHaltReason(reason))
      return { exitCode: 1, stdout: JSON.stringify({ decision: { type: 'pause', reason }, events: [] }) }
    }
  // Each way a run can end, the same rule on both runners: the standalone loop calls `keepDriverLock` with the
  // exit it describes here, the Engine runner with the exit its own result maps to.
  const exitKinds: Array<{
    name: string
    scenario: (control: RunControl) => Scenario
    standalone: DriverLockExit
    kept: boolean
  }> = [
    { name: 'a publish', scenario: () => ({}), standalone: { kind: 'publish', watched: false }, kept: false },
    {
      name: 'a halt',
      scenario: (control) => ({ actions: { 'harness.run-gates': () => haltThen(control, 'stop') } }),
      standalone: { kind: 'pause', reason: 'halt', watched: false },
      kept: false
    },
    {
      name: 'a pause only a Principal decides',
      scenario: (control) => ({ actions: { 'vinaya.assess-round': decided('escalation', control) } }),
      standalone: { kind: 'pause', reason: 'escalation', watched: false },
      kept: false
    },
    {
      name: 'an infrastructure pause',
      scenario: (control) => ({ actions: { 'vinaya.assess-round': decided('infrastructure', control) } }),
      standalone: { kind: 'pause', reason: 'infrastructure', watched: false },
      kept: true
    },
    {
      name: 'a stale-driver pause',
      scenario: (control) => ({ actions: { 'vinaya.assess-round': decided('stale_driver', control) } }),
      standalone: { kind: 'pause', reason: 'stale_driver', watched: false },
      kept: true
    },
    {
      name: 'an uncaught error',
      scenario: () => ({
        actions: {
          'harness.run-gates': () => {
            throw new Error('the gate broke')
          }
        }
      }),
      standalone: { kind: 'crash', hostRepair: false },
      kept: true
    },
    {
      name: 'a revision ceiling reached',
      scenario: () => ({ actions: { 'harness.run-gates': () => ({ exitCode: 1 }) } }),
      standalone: { kind: 'pause', reason: 'max_rounds', watched: false },
      kept: false
    }
  ]
  for (const agent of ['claude', 'codex'] as const)
    for (const kind of exitKinds)
      test(`${kind.name}: the lock is ${kind.kept ? 'kept' : 'cleared'} on both runners (${agent})`, async () => {
        const control = createRunControl()
        const run = stubRun({ ...kind.scenario(control), agent, control })
        await runEngine(run.options)
        expect(readDriverLock(run.runtimeDir, TASK) !== null).toBe(kind.kept)
        expect(keepDriverLock(kind.standalone)).toBe(kind.kept)
        expect(exitsOf(run.events)).toHaveLength(1)
      })

  test('the watching driver keeps the lock at any pause, the one case only the standalone loop has', () => {
    expect(keepDriverLock({ kind: 'pause', reason: 'escalation', watched: true })).toBe(true)
  })

  test('a leg that ended by signal or halt maps to a pause no one has to repair', () => {
    expect(lockExitOf({ reason: 'signal', lastDecision: 'cancel' })).toEqual({
      kind: 'pause',
      reason: 'halt',
      watched: false
    })
    expect(lockExitOf({ reason: 'error', lastDecision: 'error', failedStep: true })).toEqual({
      kind: 'crash',
      hostRepair: false
    })
  })

  test('the standalone loop calls the moved functions rather than carrying its own copies', () => {
    const source = readFileSync(join(repoRoot, 'apps/cli/src/lib/dev-review-loop.ts'), 'utf8')
    for (const call of ['createDriverExitRecorder(', 'emitDriverHeartbeat(', 'keepDriverLock(', 'seedLoopHistory('])
      expect(source).toContain(call)
    expect(source).not.toContain('function recordDriverExited(')
    expect(source).not.toContain('function seedLoopHistory(')
    expect(source).not.toContain('const DRIVER_HEARTBEAT_INTERVAL_MS')
  })
})

// --- re-run ----------------------------------------------------------------------

describe('re-running a task', () => {
  test('with no checkpoint it starts fresh, on the existing branch', async () => {
    const run = stubRun()
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(0)
    expect(run.driverLog()).toContain('no checkpoint; starting fresh on branch task/issue-7')
    expect(run.spawns).toEqual(['develop', 'code-review', 'security-review'])
    expect(run.actionRuns['prepare-run']).toBe(1)
  })

  test('with a checkpoint it resumes: no finished step runs again and the Developer is not launched again', async () => {
    const control = createRunControl()
    const first = stubRun({
      control,
      actions: { 'harness.run-gates': () => haltThen(control, 'stop') }
    })
    const halted = await runEngine(first.options)
    expect(halted.exitCode).toBe(2)
    expect(first.spawns).toEqual(['develop'])

    const second = stubRun({}, first.runtimeDir)
    const resumed = await runEngine(second.options)
    expect(resumed.exitCode).toBe(0)
    expect(second.driverLog()).toContain('resuming the run from its checkpoint')
    expect(second.spawns).toEqual(['code-review', 'security-review'])
    for (const step of ['prepare-run', 'reconcile-external-state', 'prepare-sources', 'validate-developer-output'])
      expect(second.actionRuns[step]).toBeUndefined()
    // The halt landed after the gate step finished, so the next step to run is the one after it.
    expect(second.actionRuns['run-mechanical-gates']).toBeUndefined()
    expect(second.actionRuns['classify-gate-result']).toBe(1)
    // The first leg's checkpoint is the second's: the lock between them was cleared by the halt.
    expect(readDriverLock(first.runtimeDir, TASK)).toBeNull()
  })

  test('a checkpoint resume keeps the round it stopped in: the journal never seeds the next round', async () => {
    const control = createRunControl()
    const first = stubRun({
      control,
      actions: { 'harness.run-gates': () => haltThen(control, 'stop') }
    })
    expect((await runEngine(first.options)).exitCode).toBe(2)
    const second = stubRun({}, first.runtimeDir)
    const seededRounds: number[] = []
    second.options.taskInput = {
      branch: 'task/issue-7',
      loopState: initialLoopState({ loopId: 'l', task: TASK, reviewers: [], models: {}, maxRounds: 5 } as never),
      reviewRound: () => 1,
      seedRound: (n: number) => void seededRounds.push(n)
    } as unknown as TaskInput
    second.options.lifecycle = {
      ...second.options.lifecycle,
      recovery: recoveryDeps({
        fetchLoopHistory: () =>
          loopHistoryFromComments(
            [{ body: '<!-- aeg:developer:round-1 -->\nHead: h1', author: 'principal' }],
            ['principal'],
            () => 'unknown'
          ),
        loopState: () => (second.options.taskInput as TaskInput).loopState
      })
    }
    second.options.heldPullRequestConflicts = async () => false
    await runEngine(second.options)
    expect(second.driverLog()).toContain('resuming the run from its checkpoint')
    expect(seededRounds).toEqual([])
  })

  test('a checkpoint whose pull request is now in conflict is not resumed: a fresh run sends the Developer back', async () => {
    const control = createRunControl()
    const first = stubRun({
      control,
      actions: { 'harness.run-gates': () => haltThen(control, 'stop') }
    })
    expect((await runEngine(first.options)).exitCode).toBe(2)
    const second = stubRun({}, first.runtimeDir)
    second.options.heldPullRequestConflicts = async () => true
    await runEngine(second.options)
    expect(second.driverLog()).toContain('instead of resuming the checkpoint')
    expect(second.driverLog()).not.toContain('resuming the run from its checkpoint')
    expect(second.spawns[0]).toBe('develop')
  })

  test('a checkpoint that spent its round budget is not resumed: the run pauses max_rounds durably', async () => {
    const failingGates = { 'vinaya.assess-gate': async () => ({ exitCode: 1, stdout: 'checks failed' }) }
    const first = stubRun({ actions: failingGates })
    const firstResult = await runEngine(first.options)
    expect(first.trace(firstResult.tracePath).outcome).toBe('exhausted')
    const second = stubRun({ actions: failingGates }, first.runtimeDir)
    const result = await runEngine(second.options)
    expect(second.driverLog()).toContain('spent its round budget')
    expect(second.driverLog()).not.toContain('uncaught error')
    expect(second.handoff.calls).toContain('pause-state:max_rounds')
    expect(second.spawns).toEqual([])
    expect(result.exitCode).not.toBe(0)
  })

  test('a run whose checkpoint records a completed run has nothing to run', async () => {
    const first = stubRun()
    await runEngine(first.options)
    const again = stubRun({}, first.runtimeDir)
    const result = await runEngine(again.options)
    expect(result.exitCode).toBe(0)
    expect(again.spawns).toEqual([])
    expect(again.driverLog()).toContain('the checkpoint records a completed run')
    expect(exitsOf(again.events)).toHaveLength(1)
  })

  test('a fresh start that finds an open pull request attaches to it and dispatches no Developer', async () => {
    const reconcile = ACTION_BINDINGS['vinaya.reconcile-external-state']!.build({
      branch: 'task/issue-7',
      bound: { findOpenPrForBranch: () => ({ number: 31, branch: 'task/issue-7' }) }
    } as unknown as TaskInput)
    expect(
      await reconcile({ nodeId: 'reconcile-external-state', action: 'vinaya.reconcile-external-state', results: {} })
    ).toMatchObject({
      exitCode: EXIT_OPEN_PR
    })
    const run = stubRun({ actions: { 'vinaya.reconcile-external-state': reconcile } })
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(0)
    expect(run.spawns).toEqual(['code-review', 'security-review'])
    const trace = run.trace(result.tracePath)
    expect(trace.steps.map((step) => step.nodeId)).toEqual([
      'prepare-run',
      'reconcile-external-state',
      'prepare-sources',
      'choose-start',
      'run-mechanical-gates',
      'check-mergeability',
      'classify-mergeability',
      'read-forge-ci',
      'check-premise',
      'assess-gate',
      'classify-gate-result',
      'run-security-scan',
      'dispatch-reviewers',
      'code-review',
      'security-review',
      'validate-reviewer-outputs',
      'classify-reviewer-outputs',
      'assess-round',
      'build-revision-handoff',
      'run-live-checks',
      'classify-live-result',
      'check-publish-mergeability',
      'classify-publish-mergeability',
      'publish-ready-for-merge'
    ])
  })

  test('a start that finds no open pull request launches the Developer', async () => {
    const run = stubRun()
    const result = await runEngine(run.options)
    expect(run.trace(result.tracePath).steps.map((step) => step.nodeId)).toContain('develop')
    expect(run.spawns[0]).toBe('develop')
  })
})

describe('resuming on code that moved', () => {
  test('continues at the next step on the current code, and appends one line naming both revisions', async () => {
    const control = createRunControl()
    const first = stubRun({
      control,
      revision: 'rev-old',
      actions: { 'harness.run-gates': () => haltThen(control, 'stop') }
    })
    await runEngine(first.options)
    expect(first.driverLog()).not.toContain('checkpoint was made at revision')

    const second = stubRun({ revision: 'rev-new' }, first.runtimeDir)
    const result = await runEngine(second.options)
    expect(result.exitCode).toBe(0)
    const moved = second
      .driverLog()
      .split('\n')
      .filter((line) => line.includes('rev-old'))
    expect(moved).toHaveLength(1)
    expect(moved[0]).toContain('rev-new')
    expect(moved[0]).toContain('the checkpoint was made at revision rev-old')
    // No completed step ran again, and the Developer's work stood.
    expect(second.spawns).toEqual(['code-review', 'security-review'])
    for (const step of ['prepare-run', 'prepare-sources', 'validate-developer-output'])
      expect(second.actionRuns[step]).toBeUndefined()
  })

  test('says nothing when the revision did not move', async () => {
    const control = createRunControl()
    const first = stubRun({ control, actions: { 'harness.run-gates': () => haltThen(control, 'stop') } })
    await runEngine(first.options)
    const second = stubRun({}, first.runtimeDir)
    await runEngine(second.options)
    expect(second.driverLog()).not.toContain('the checkpoint was made at revision')
    expect(revisionMovedLine('rev-a', 'rev-a')).toBeNull()
    expect(revisionMovedLine(undefined, 'rev-a')).toBeNull()
  })

  test('chooses to resume from the revision the newest checkpoint recorded', async () => {
    const control = createRunControl()
    const first = stubRun({
      control,
      revision: 'rev-old',
      actions: { 'harness.run-gates': () => haltThen(control, 'x') }
    })
    await runEngine(first.options)
    const { SqliteCheckpointer } = await import('../../../harness/dev-process/engine-runtime/sqlite-checkpointer')
    const saver = new SqliteCheckpointer({
      path: join(first.runtimeDir, 'engine-runs', String(TASK), 'checkpoints.sqlite'),
      revision: 'rev-new'
    })
    try {
      expect(await chooseStart(saver, runIdentityOfTask(TASK))).toMatchObject({
        kind: 'resume',
        checkpointRevision: 'rev-old'
      })
      expect(await chooseStart(new MemorySaver(), runIdentityOfTask(TASK))).toEqual({
        kind: 'fresh',
        identity: runIdentityOfTask(TASK)
      })
    } finally {
      saver.close()
    }
  })
})

// --- recovery ---------------------------------------------------------------------

const objectives = [{ id: 'O1', text: 'Do the thing.' }]
const manifestAt = (headSha: string): ReviewInputManifest =>
  buildReviewInputManifest({
    headSha,
    baseSha: 'b'.repeat(40),
    briefContent: '# brief\n',
    objectivesVersion: objectivesVersion(objectives),
    rulingOrdinal: 0,
    policy: DEFAULT_REVIEW_POLICY
  })

/** Holds an approving pair for `round`, rendered as the Engine's own review step renders them. */
function holdCleanPair(runtimeDir: string, round: number, manifest: ReviewInputManifest): void {
  for (const [role, reviewRole] of [
    ['reviewer', 'code-reviewer'],
    ['security', 'security-reviewer']
  ] as const) {
    const parsed = parseReviewResult({
      reviewResult: {
        schemaVersion: 1,
        role: reviewRole,
        status: 'completed',
        headSha: manifest.headSha,
        manifestDigest: manifestDigest(manifest),
        summary: 'Fine.',
        findings: [],
        objectiveResults: objectives.map((o) => ({ id: o.id, status: 'MET', evidence: 'It does.' }))
      }
    })
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    const built = buildVerdictFromReview(
      role,
      parsed.result,
      'claude',
      TASK,
      { exitCode: 0, durationMs: 0, usage: null } as never,
      manifest,
      DEFAULT_REVIEW_POLICY,
      objectives
    )
    writeHeldVerdict(runtimeDir, TASK, round, role, built.rendered)
  }
}

const noLaunch: ParsedLaunch = { status: 'absent' }
function launchRecord(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    runId: 'r',
    role: 'developer',
    agent: 'claude',
    repo: null,
    task: TASK,
    pr: null,
    round: 1,
    attempt: 1,
    effectId: 'e',
    dispatcherPid: 900,
    childPid: 901,
    childStartedAt: 'Mon Jan  1 00:00:00 2026',
    childCommand: 'claude',
    host: hostname(),
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'launched',
    resumeId: null,
    boundAt: null,
    finishedAt: null,
    failureReason: null,
    ...over
  }
}

function recoveryDeps(over: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    prNumber: () => 31,
    fetchLoopHistory: () => loopHistoryFromComments([], ['principal'], () => 'unknown'),
    loopState: () => initialLoopState({ loopId: 'l', task: TASK, reviewers: [], models: {}, maxRounds: 5 } as never),
    readLaunch: () => noLaunch,
    launchDeps: {
      isPidAlive: () => false,
      hostname: () => hostname(),
      getProcessSnapshot: () => null,
      terminateChild: () => {}
    },
    heldVerdict: () => null,
    currentManifest: () => null,
    ...over
  }
}

describe('recovering a re-run', () => {
  test('a prior Developer launch still running is not raced: the runner dispatches nothing', async () => {
    const record = launchRecord()
    const run = stubRun({
      lifecycle: {
        recovery: recoveryDeps({
          readLaunch: () => ({ status: 'ok', record }),
          launchDeps: {
            isPidAlive: () => true,
            hostname: () => record.host,
            getProcessSnapshot: () =>
              ({ ppid: record.dispatcherPid, startedAt: record.childStartedAt, command: record.childCommand }) as never,
            terminateChild: () => {}
          }
        })
      }
    })
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(2)
    expect(run.spawns).toEqual([])
    expect(Object.keys(run.actionRuns)).toEqual([])
    expect(run.driverLog()).toContain('not dispatching')
    expect(run.trace(result.tracePath).error).toContain('is still running')
  })

  test('a launch that ended before binding a session dispatches a fresh Developer, and the Log records the prior attempt', async () => {
    const run = stubRun({
      lifecycle: {
        recovery: recoveryDeps({
          readLaunch: () => ({ status: 'ok', record: launchRecord({ status: 'interrupted', failureReason: 'signal' }) })
        })
      }
    })
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(0)
    expect(run.spawns).toEqual(['develop', 'code-review', 'security-review'])
    expect(run.driverLog()).toContain('launch_ended_unbound: attempt=1 outcome=cancelled reason=signal')
  })

  test('a corrupt launch record is reconciled as a pause, never a silent fresh start', () => {
    const recovery = recoverRun(recoveryDeps({ readLaunch: () => ({ status: 'corrupt', reason: 'torn write' }) }))
    expect(recovery.launch.kind).toBe('pause')
    expect(recovery.refusal).toContain('corrupt')
  })

  test('a finished launch with a bound session is resumed rather than refused', () => {
    const recovery = recoverRun(
      recoveryDeps({
        readLaunch: () => ({ status: 'ok', record: launchRecord({ status: 'completed', resumeId: 's-1' }) })
      })
    )
    expect(recovery.launch).toMatchObject({ kind: 'resume', resumeId: 's-1' })
    expect(recovery.refusal).toBeNull()
  })

  test('an abandoned child is ended before the launch is reconciled', () => {
    const record = launchRecord()
    const ended: number[] = []
    recoverRun(
      recoveryDeps({
        readLaunch: () => ({ status: 'ok', record }),
        launchDeps: {
          isPidAlive: () => false,
          hostname: () => record.host,
          getProcessSnapshot: () =>
            ({ ppid: 1, startedAt: record.childStartedAt, command: record.childCommand }) as never,
          terminateChild: (pid) => void ended.push(pid)
        }
      })
    )
    expect(ended).toEqual([901])
  })

  test('a held clean verdict that still covers the moved head is published as it stands, without a new review', async () => {
    const run = stubRun()
    holdCleanPair(run.runtimeDir, 1, manifestAt('1'.repeat(40)))
    const held = latestHeldCleanVerdict(run.runtimeDir, TASK)
    expect(held).toMatchObject({ round: 1, head: '1'.repeat(40) })
    run.options.lifecycle = {
      ...run.options.lifecycle,
      recovery: recoveryDeps({
        heldVerdict: () => latestHeldCleanVerdict(run.runtimeDir, TASK),
        currentManifest: () => manifestAt('2'.repeat(40)),
        // The head moved by a patch-identical rebase.
        patchIdOf: () => 'same-patch'
      })
    }
    run.options.heldPullRequestConflicts = async () => false
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(0)
    expect(run.spawns).toEqual([])
    expect(run.actionRuns['publish-ready-for-merge']).toBe(1)
    expect(Object.keys(run.actionRuns)).toEqual(['publish-ready-for-merge'])
    expect(run.driverLog()).toContain('held clean verdict from round 1 still covers the head')
    expect(run.trace(result.tracePath).outcome).toBe('completed')
  })

  test('a held clean verdict whose pull request is in conflict is not published; the run goes through the Flow', async () => {
    const run = stubRun()
    holdCleanPair(run.runtimeDir, 1, manifestAt('1'.repeat(40)))
    run.options.lifecycle = {
      ...run.options.lifecycle,
      recovery: recoveryDeps({
        heldVerdict: () => latestHeldCleanVerdict(run.runtimeDir, TASK),
        currentManifest: () => manifestAt('2'.repeat(40)),
        patchIdOf: () => 'same-patch'
      })
    }
    run.options.heldPullRequestConflicts = async () => true
    await runEngine(run.options)
    expect(run.driverLog()).toContain('held clean verdict not published: the pull request is in conflict')
    expect(run.driverLog()).not.toContain('still covers the head; publishing it')
    expect(Object.keys(run.actionRuns)).not.toEqual(['publish-ready-for-merge'])
  })

  test('the live conflict probe reads a mergeable pull request as mergeable when the task sets no poll budget', async () => {
    const probe = heldPullRequestConflictsLive({
      branch: 'task/issue-7',
      bound: {
        findOpenPrForBranch: () => ({ number: 31, branch: 'task/issue-7' }),
        fetchMergeableState: () => 'MERGEABLE'
      }
    } as unknown as TaskInput)
    expect(await probe()).toBe(false)
  })

  test('a held verdict that no longer covers the head is not reused', () => {
    const run = stubRun()
    holdCleanPair(run.runtimeDir, 1, manifestAt('1'.repeat(40)))
    const recovery = recoverRun(
      recoveryDeps({
        heldVerdict: () => latestHeldCleanVerdict(run.runtimeDir, TASK),
        currentManifest: () => manifestAt('2'.repeat(40)),
        patchIdOf: (sha) => sha
      })
    )
    expect(recovery.held).toBeNull()
  })

  test('only the highest held round counts, and a round holding changes requested is not clean', () => {
    const run = stubRun()
    holdCleanPair(run.runtimeDir, 1, manifestAt('1'.repeat(40)))
    writeHeldVerdict(run.runtimeDir, TASK, 2, 'reviewer', 'not a verdict')
    expect(latestHeldCleanVerdict(run.runtimeDir, TASK)).toBeNull()
  })
})

describe('rebuilding the round journal from the forge', () => {
  const PRINCIPALS = ['principal']
  const round = (n: number) => ({ body: `<!-- aeg:developer:round-${n} -->\nHead: h${n}`, author: 'principal' })
  const summary = {
    body: '<!-- aeg:loop:published head=abcdef1 confidence=1:90 -->\nReady for merge.',
    author: 'principal',
    url: 'https://forge.example/pr/31#c1'
  }

  const recoverWith = (comments: Parameters<typeof loopHistoryFromComments>[0], gate: 'pass' | 'fail' | 'unknown') => {
    const asked: Array<number | null> = []
    const recovery = recoverRun(
      recoveryDeps({
        fetchLoopHistory: (pr): ReconstructedJournal => {
          asked.push(pr)
          return loopHistoryFromComments(comments, PRINCIPALS, () => gate)
        }
      })
    )
    return { recovery, asked }
  }

  test('rounds come from Principal-authored markers, and the next round is numbered after them', () => {
    const { recovery, asked } = recoverWith(
      [round(1), round(2), { body: round(3).body, author: 'someone-else' }],
      'unknown'
    )
    expect(asked).toEqual([31])
    expect(recovery.state.rounds.map((r) => r.round)).toEqual([1, 2])
    expect(recovery.historyApplies).toBe(true)
    expect(recovery.nextRound).toBe(3)
  })

  test('concluded means a summary and a non-failing gate', () => {
    expect(recoverWith([round(1), summary], 'pass').recovery.historyApplies).toBe(false)
    expect(recoverWith([round(1), summary], 'unknown').recovery.historyApplies).toBe(false)
    // The gate has since failed on the posted summary: the review is open again and its rounds seed.
    const reopened = recoverWith([round(1), summary], 'fail').recovery
    expect(reopened.historyApplies).toBe(true)
    expect(reopened.nextRound).toBe(2)
    // A summary alone is not concluded without ... a summary posted by someone other than the Principal.
    expect(recoverWith([round(1), { ...summary, author: 'intruder' }], 'pass').recovery.historyApplies).toBe(true)
  })

  test('with no open pull request the journal is asked for nothing and starts the rounds at one', () => {
    const asked: Array<number | null> = []
    const recovery = recoverRun(
      recoveryDeps({
        prNumber: () => null,
        fetchLoopHistory: (pr) => {
          asked.push(pr)
          return loopHistoryFromComments([], PRINCIPALS, () => 'unknown')
        }
      })
    )
    expect(asked).toEqual([null])
    expect(recovery.nextRound).toBeNull()
  })

  test('a re-run seeds the task input from the forge journal, never from the Log', async () => {
    const run = stubRun()
    // The Log says the review concluded, and the driver log says the run finished: neither is read.
    mkdirSync(join(run.runtimeDir, 'logs'), { recursive: true })
    writeFileSync(
      join(run.runtimeDir, 'logs', 'events.jsonl'),
      `${JSON.stringify({ kind: 'dev_review_loop', event: 'journal_finalized', result: 'merged_ready', rounds: 9 })}\n`
    )
    mkdirSync(dirname(loopLogPathFor(null, TASK, run.runtimeDir)), { recursive: true })
    writeFileSync(loopLogPathFor(null, TASK, run.runtimeDir), 'driver_exited: reason=finished last_decision=publish\n')
    let rounds: number[] = []
    const seeded: TaskInput = {
      branch: 'task/issue-7',
      loopState: initialLoopState({ loopId: 'l', task: TASK, reviewers: [], models: {}, maxRounds: 5 } as never),
      reviewRound: () => 1,
      seedRound: (n: number) => {
        rounds = [n]
      }
    } as unknown as TaskInput
    run.options.taskInput = seeded
    run.options.lifecycle = {
      ...run.options.lifecycle,
      recovery: recoveryDeps({
        fetchLoopHistory: () => loopHistoryFromComments([round(1), round(2)], PRINCIPALS, () => 'unknown'),
        loopState: () => seeded.loopState
      })
    }
    const touched = new Set<string | symbol>()
    const deps = run.options.lifecycle?.recovery as RecoveryDeps
    run.options.lifecycle = {
      ...run.options.lifecycle,
      recovery: new Proxy(deps, {
        get: (target, key) => {
          touched.add(key)
          return Reflect.get(target, key)
        }
      })
    }
    await runEngine(run.options)
    expect(seeded.loopState.rounds.map((r) => r.round)).toEqual([1, 2])
    expect(rounds).toEqual([3])
    // Recovery reads the forge, the launch record and the held verdicts, and nothing that could be the Log.
    expect([...touched].sort()).toEqual(
      ['fetchLoopHistory', 'heldVerdict', 'launchDeps', 'loopState', 'prNumber', 'readLaunch'].sort()
    )
  })
})

// --- role ceilings ----------------------------------------------------------------

describe('the ceiling each role launches with', () => {
  test('is the one resolveDispatchTimeoutMs gives that role: the defaults', () => {
    expect(roleTimeouts(undefined)).toEqual({
      developer: DEFAULT_TIMEOUT_MS,
      'code-reviewer': DEFAULT_REVIEWER_TIMEOUT_MS,
      'security-reviewer': DEFAULT_REVIEWER_TIMEOUT_MS
    })
  })

  test('is the one resolveDispatchTimeoutMs gives that role: an override', () => {
    expect(roleTimeouts({ timeoutMs: 111, reviewerTimeoutMs: 222 })).toEqual({
      developer: 111,
      'code-reviewer': 222,
      'security-reviewer': 222
    })
    expect(roleTimeouts({ timeoutMs: 111 })).toMatchObject({
      developer: 111,
      'code-reviewer': DEFAULT_REVIEWER_TIMEOUT_MS
    })
  })

  for (const vendor of ['claude-code', 'codex'] as const)
    test(`reaches each role's launcher as its timeoutMs (${vendor})`, () => {
      const generatedRoot = mkdtempSync(join(tmpdir(), 'ceiling-roles-'))
      const roles = createRoleLaunchers({
        vendor,
        generatedRoot,
        timeouts: roleTimeouts({ timeoutMs: 111, reviewerTimeoutMs: 222 })
      })
      expect(Object.fromEntries(Object.entries(roles).map(([role, launcher]) => [role, launcher.timeoutMs]))).toEqual({
        developer: 111,
        'code-reviewer': 222,
        'security-reviewer': 222
      })
      const defaults = createRoleLaunchers({ vendor, generatedRoot, timeouts: roleTimeouts(undefined) })
      expect(defaults.developer?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
      expect(defaults['code-reviewer']?.timeoutMs).toBe(DEFAULT_REVIEWER_TIMEOUT_MS)
      expect(defaults['security-reviewer']?.timeoutMs).toBe(DEFAULT_REVIEWER_TIMEOUT_MS)
    })

  test('bounds a launch that never ends: the Developer by the override, then a reviewer by its own', async () => {
    const developer = stubRun({ hang: ['developer'], lifecycle: { dispatchConfig: { timeoutMs: 60 } } })
    const first = await runEngine(developer.options)
    expect(first.exitCode).toBe(2)
    const failedStep = (run: ReturnType<typeof stubRun>, path: string, node: string) =>
      run.trace(path).steps.find((step) => step.nodeId === node)?.error
    expect(failedStep(developer, first.tracePath, 'develop')).toMatch(/'developer'.*exceeded its 60ms timeout/)

    const reviewer = stubRun({ hang: ['code-reviewer'], lifecycle: { dispatchConfig: { reviewerTimeoutMs: 60 } } })
    const second = await runEngine(reviewer.options)
    expect(second.exitCode).toBe(2)
    expect(reviewer.spawns).toContain('develop')
    expect(failedStep(reviewer, second.tracePath, 'code-review')).toMatch(/'code-reviewer'.*exceeded its 60ms timeout/)
  })
})

// --- narration, heartbeat and exit ---------------------------------------------------

describe('the heartbeat and the exit record', () => {
  /** A clock the test turns: the runner starts its timer here and the test decides when time passes. */
  function fakeClock() {
    const timers: Array<{ cb: () => void; every: number; at: number; stopped: boolean }> = []
    let now = 0
    return {
      setHeartbeat: (cb: () => void, every: number) => {
        const timer = { cb, every, at: every, stopped: false }
        timers.push(timer)
        return () => {
          timer.stopped = true
        }
      },
      advance(ms: number) {
        now += ms
        for (const timer of timers)
          while (!timer.stopped && timer.at <= now) {
            timer.at += timer.every
            timer.cb()
          }
      },
      timers
    }
  }

  test('beats every five minutes with where the run is, stops before the exit, and records the exit once', async () => {
    const clock = fakeClock()
    const order: string[] = []
    const run = stubRun({
      lifecycle: { setHeartbeat: clock.setHeartbeat },
      actions: {
        'vinaya.reconcile-external-state': () => ({ exitCode: 0, stdout: JSON.stringify({ number: 31 }) }),
        'harness.run-gates': () => {
          clock.advance(DRIVER_HEARTBEAT_INTERVAL_MS - 1)
          order.push(`beats:${run.events.filter((e) => e.event === 'driver_heartbeat').length}`)
          clock.advance(1)
          clock.advance(2 * DRIVER_HEARTBEAT_INTERVAL_MS)
          return { exitCode: 0 }
        }
      }
    })
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(0)
    expect(DRIVER_HEARTBEAT_INTERVAL_MS).toBe(5 * 60 * 1000)
    expect(clock.timers).toHaveLength(1)
    expect(clock.timers[0]?.every).toBe(300_000)
    expect(order).toEqual(['beats:0'])
    const beats = run.events.filter((event) => event.event === 'driver_heartbeat')
    expect(beats).toHaveLength(3)
    expect(beats[0]).toMatchObject({
      kind: 'dev_review_loop',
      loop_id: 'lifecycle-test',
      task: TASK,
      phase: 'run-mechanical-gates',
      pr: 31
    })
    // The timer is stopped before the exit line, and the exit is one line.
    expect(clock.timers[0]?.stopped).toBe(true)
    const exits = exitsOf(run.events)
    expect(exits).toHaveLength(1)
    // As on the standalone driver, a finished run's exit record carries no exit code.
    expect(exits[0]).toMatchObject({ reason: 'finished', last_decision: 'publish', task: TASK })
    expect(exits[0]).not.toHaveProperty('exit_code')
    expect(run.events.at(-1)?.event).toBe('driver_exited')
  })

  test('records one exit when the run fails, with the class of the failure', async () => {
    const clock = fakeClock()
    const run = stubRun({
      lifecycle: { setHeartbeat: clock.setHeartbeat },
      actions: {
        'harness.run-gates': () => {
          throw new Error('the gate broke')
        }
      }
    })
    const result = await runEngine(run.options)
    // The error is handed off as an infrastructure pause, so the exit says paused, not error.
    expect(result.exitCode).toBe(2)
    const exits = exitsOf(run.events)
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ reason: 'paused', last_decision: 'pause(infrastructure)' })
    expect(exits[0]).not.toHaveProperty('error_class')
    expect(clock.timers[0]?.stopped).toBe(true)
    expect(run.driverLog()).toContain('driver exited (paused, pause(infrastructure))')
  })

  test('a pause raised before any pull request existed is bound to the one the reconcile step then finds', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'lifecycle-'))
    writePauseState(runtimeDir, {
      task: TASK,
      round: 1,
      head: 'abc',
      branch: 'task/issue-7',
      prNumber: null,
      reason: 'escalation',
      pausedAt: '2026-01-01T00:00:00.000Z'
    })
    const run = stubRun(
      {
        actions: {
          'vinaya.reconcile-external-state': () => ({
            exitCode: 0,
            stdout: JSON.stringify({ number: 70, branch: 'task/issue-7' })
          })
        }
      },
      runtimeDir
    )
    await runEngine(run.options)
    expect(readPauseState(runtimeDir, TASK)).toMatchObject({ prNumber: 70, reason: 'escalation' })
  })

  test('narrates the run to the per-task driver log', async () => {
    const run = stubRun()
    await runEngine(run.options)
    const log = run.driverLog()
    expect(log).toContain('run started')
    expect(log).toContain('no checkpoint; starting fresh on branch task/issue-7')
    expect(log).toContain('driver exited (finished, publish); driver lock cleared')
  })
})

// --- no orphaned agent ----------------------------------------------------------------

const agentScript = (dir: string): string => {
  const path = join(dir, 'agent.sh')
  // A stand-in for a vendor CLI: it records its argv and environment, starts a child of its own, and waits.
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'record="$1"; shift',
      'printf "%s\\n" "CODEX_HOME=$CODEX_HOME" "$@" > "$record"',
      'sleep 300 &',
      'echo $! > "$record.child"',
      'echo $$ > "$record.agent"',
      'wait',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  return path
}

describe('no orphaned agent', () => {
  test('decide: halting the run control alone leaves what the agent started running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'decide-'))
    const pidFile = join(dir, 'child.pid')
    const control = createRunControl()
    const actions: ActionRegistry = Object.fromEntries(
      Object.keys(ACTION_BINDINGS).map((name) => [name, () => ({ exitCode: 0 })])
    )
    const { decisions } = await import('../executing/actions')
    const options: ProcessRunOptions = {
      process: loaded,
      question: 'q',
      bindings: {
        actions,
        decisions,
        roles: createRoleLaunchers({ vendor: 'claude-code', generatedRoot: join(dir, 'gen') })
      },
      checkpointer: new MemorySaver(),
      workingDirectoryRoot: dir,
      control,
      // What the executor does by default: a plain child, not a group of its own.
      spawnFn: (_command, _args, options) =>
        spawn('sh', ['-c', `sleep 300 & echo $! > ${pidFile}; wait`], options) as never
    }
    const run = startProcessRun(options)
    await until(() => existsSync(pidFile))
    const child = Number(readFileSync(pidFile, 'utf8').trim())
    control.halt('test')
    expect((await run).reason).toBe('paused')
    await sleep(300)
    const survived = alive(child)
    try {
      process.kill(child, 'SIGKILL')
    } catch {}
    // The executor ends the agent it spawned and nothing else, so reaping is the runner's to do.
    expect(survived).toBe(true)
  }, 30_000)

  test('the runner ends the agent’s whole process group when the run control is halted mid-launch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reap-'))
    const record = join(dir, 'argv')
    const script = agentScript(dir)
    const control = createRunControl()
    const run = stubRun({ control })
    run.options.spawnFn = (_command, args, options) =>
      spawn('sh', [script, record, ...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] }) as never
    const running = runEngine(run.options)
    await until(() => existsSync(`${record}.child`) && readFileSync(`${record}.child`, 'utf8').trim() !== '')
    const child = Number(readFileSync(`${record}.child`, 'utf8').trim())
    const agent = Number(readFileSync(`${record}.agent`, 'utf8').trim())
    expect(alive(child) && alive(agent)).toBe(true)
    control.halt('stop')
    const result = await running
    expect(result.exitCode).toBe(2)
    await until(() => !alive(child) && !alive(agent), 5000)
  }, 30_000)

  test('reaps a group whose leader already exited', async () => {
    const reaper = createChildReaper()
    const dir = mkdtempSync(join(tmpdir(), 'reap-leader-'))
    const pidFile = join(dir, 'child.pid')
    const child = reaper.spawnFn('sh', ['-c', `sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}`], {
      cwd: dir,
      env: process.env
    })
    await new Promise<void>((done) => child.on('close', () => done()))
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(grandchild)).toBe(true)
    expect(reaper.groups()).toHaveLength(1)
    await reaper.reap(200)
    await until(() => !alive(grandchild), 3000)
    expect(reaper.groups()).toEqual([])
  })

  test('reads one start time for a live process however often it is read', async () => {
    const reads: (string | null)[] = []
    for (let read = 0; read < 12; read++) {
      reads.push(liveStartTime(process.pid))
      await new Promise((resolve) => setTimeout(resolve, 125))
    }
    expect(new Set(reads).size).toBe(1)
    // Where the kernel's own start time can be read, it is the one recorded.
    if (existsSync(`/proc/${process.pid}/stat`)) expect(reads[0]).toMatch(/^ticks:\d+$/)
  })

  for (const agent of ['claude', 'codex'] as const)
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      test(`${signal} sent to the runner during a ${agent} launch leaves no process of the agent`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'signal-'))
        const record = join(dir, 'argv')
        const runner = spawn(
          process.execPath,
          [
            join(import.meta.dir, 'fixtures/run-lifecycle-runner.ts'),
            agent,
            join(dir, 'runtime'),
            agentScript(dir),
            record
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let output = ''
        runner.stdout.on('data', (chunk) => (output += String(chunk)))
        runner.stderr.on('data', (chunk) => (output += String(chunk)))
        const exited = new Promise<number | null>((done) => runner.on('close', (code) => done(code)))
        try {
          await until(
            () => existsSync(`${record}.child`) && readFileSync(`${record}.child`, 'utf8').trim() !== '',
            20_000
          )
          const child = Number(readFileSync(`${record}.child`, 'utf8').trim())
          const agentPid = Number(readFileSync(`${record}.agent`, 'utf8').trim())
          // The launch has the shape of its vendor.
          const argv = readFileSync(record, 'utf8')
          if (agent === 'claude') expect(argv).toContain('--settings')
          else expect(argv).toMatch(/CODEX_HOME=\S*\/codex\/|CODEX_HOME=\S+/)
          expect(alive(child) && alive(agentPid)).toBe(true)
          runner.kill(signal)
          const code = await exited
          expect(code).toBe(signal === 'SIGTERM' ? 143 : 130)
          await until(() => !alive(child) && !alive(agentPid), 5000)
          expect(output).toContain(`exit ${signal === 'SIGTERM' ? 143 : 130}`)
        } finally {
          runner.kill('SIGKILL')
          for (const pidFile of [`${record}.child`, `${record}.agent`])
            if (existsSync(pidFile))
              try {
                process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
              } catch {}
        }
      }, 40_000)

  test('a signalled run records one exit by signal and clears its lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-exit-'))
    const record = join(dir, 'argv')
    const runtimeDir = join(dir, 'runtime')
    const runner = spawn(
      process.execPath,
      [join(import.meta.dir, 'fixtures/run-lifecycle-runner.ts'), 'claude', runtimeDir, agentScript(dir), record],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const exited = new Promise<number | null>((done) => runner.on('close', (code) => done(code)))
    await until(() => existsSync(`${record}.child`) && readFileSync(`${record}.child`, 'utf8').trim() !== '', 20_000)
    expect(readDriverLock(runtimeDir, TASK)).toMatchObject({ pid: runner.pid })
    runner.kill('SIGTERM')
    expect(await exited).toBe(143)
    expect(readDriverLock(runtimeDir, TASK)).toBeNull()
    const log = readFileSync(loopLogPathFor(null, TASK, runtimeDir), 'utf8')
    expect(log).toContain('received SIGTERM')
    expect(log).toContain('driver exited (signal, cancel); driver lock cleared')
    spawnSync('sh', ['-c', `kill $(cat ${record}.child) 2>/dev/null; true`])
  }, 40_000)
})
