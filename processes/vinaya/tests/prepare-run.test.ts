import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialLoopState } from '@attalabs/aeg-core'
import { createRunControl, type RunControl } from '@atta/executor-agent-spawn'
import { MemorySaver } from '@langchain/langgraph'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import {
  resumeProcessRun,
  startProcessRun,
  type ProcessAction,
  type ProcessRunOptions
} from '../../../harness/dev-process/engine-runtime/run-process'
import { isHostRepairPause, readPauseState } from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { DispatchSandboxRefused } from '../../../apps/cli/src/lib/dev-review-loop/round-assess'
import type { EnforcementControl } from '../../../apps/cli/src/lib/enforcement-controls'
import type { PreparedSource, RequiredSourceManifest } from '../../../apps/cli/src/lib/source-manifest'
import { sourceReceiptsPath } from '../../../apps/cli/src/lib/source-manifest'
import { SourceReaderUnavailable } from '../../../apps/cli/src/lib/source-provider'
import type { FetchDocumentationDeps } from '../../../apps/cli/src/lib/task-tools/fetch-documentation'
import type { SandboxProbePlan } from '../../../apps/cli/src/lib/worker-boundary'
import { BRANCH, fakeDeps, makeWorld } from '../../../apps/cli/tests/lib/task-tools/live-developer-context-world'
import { createActions, createRoleLaunchers, sandboxProbePlanFor, type TaskInput } from '../executing/actions'
import { createHandoff } from '../executing/handoff'
import { handoffHaltReason } from '../executing/log-events'
import { developerSourceStoreDir, engineLiveDevToolsContext, liveTaskInput } from '../bin/run-engine'
import { recordedHandoff } from './handoff-fakes'

const TASK = 10
const URL_SOURCE = 'https://docs.example.com/hooks'

type Result = { exitCode: number; stdout?: string }
type Action = (context: never) => Promise<Result> | Result

const activeGate: EnforcementControl = { control: 'local-gate', active: true, detail: '', remedy: '' }
const missingGate: EnforcementControl = {
  control: 'local-gate',
  active: false,
  detail: 'the pre-push hook is not installed.',
  remedy: 'run `vinaya install`.'
}

/** A handoff whose pauses are recorded and halt `control`. */
function handoffFor(runtimeDir: string, control: RunControl, recorded: ReturnType<typeof recordedHandoff>) {
  return createHandoff(
    {
      task: TASK,
      branch: BRANCH,
      runtimeDir,
      runId: 'run-1',
      agent: 'claude',
      round: () => 1,
      head: () => 'abc123',
      prNumber: () => null,
      versions: () => ({
        briefHash: 'brief',
        objectivesVersion: 'objectives',
        rulingOrdinal: 0,
        policyDigest: 'unknown'
      }),
      halt: (reason) => control.halt(handoffHaltReason(reason))
    },
    'loop-1',
    recorded.deps
  )
}

/** One run of the Flow's preparation steps over a runtime folder of its own, its pauses handed off and recorded. */
function setup(overrides: Partial<TaskInput> = {}) {
  const runtimeDir = overrides.runtimeDir ?? mkdtempSync(join(tmpdir(), 'prepare-run-'))
  const control = createRunControl()
  const recorded = recordedHandoff()
  const handoff = handoffFor(runtimeDir, control, recorded)
  const calls: string[] = []
  const task = {
    runtimeDir,
    issueNumber: TASK,
    branch: BRANCH,
    worktreePath: join(runtimeDir, 'worktree'),
    developerContext: { knownFindingIds: [], requiredSources: [] },
    loopState: initialLoopState({
      loopId: 'loop-1',
      task: TASK,
      reviewers: ['reviewer', 'security'],
      models: {},
      maxRounds: 5,
      maxTaskMinutes: 0
    }),
    handoff,
    bound: {
      checkTaskDispatchReadiness: () => {
        calls.push('readiness')
        return { ready: true, output: 'ready' }
      },
      createTaskWorktree: () => {
        calls.push('worktree')
      },
      fetchSourceRevision: () => 'revision-1',
      localGateControl: () => activeGate,
      probeAgentSandbox: async () => {
        calls.push('probe')
        return { ok: true as const }
      }
    },
    ...overrides
  } as unknown as TaskInput
  const run = (name: 'vinaya.prepare-run' | 'vinaya.prepare-sources') =>
    (createActions(task)[name] as unknown as Action)({} as never)
  return { task, run, control, recorded, runtimeDir, calls }
}

const paused = (runtimeDir: string) => readPauseState(runtimeDir, TASK)

describe('prepare-run reads the review policy', () => {
  test('an unreadable policy pauses through the handoff and the run input is still built', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'prepare-run-live-'))
    // The input is built without a policy read: a throw here would end the start before any record is written.
    const live = await liveTaskInput({ task: TASK, agent: 'claude', dryRun: false }, runtimeDir, runtimeDir, 'loop-1', {
      fetchTitle: () => 'A task',
      fetchLabels: () => [],
      policy: () => {
        throw new Error('trust-anchor read failed')
      }
    })
    const { task, run, control, recorded, calls } = setup({
      reviewPolicy: live.reviewPolicy,
      runtimeDir
    })
    const result = await run('vinaya.prepare-run')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('trust-anchor read failed')
    expect(recorded.calls).toEqual([
      'escalation:infrastructure',
      'pause-state:infrastructure',
      'comment:issue:infrastructure'
    ])
    expect(paused(runtimeDir)).toMatchObject({ reason: 'infrastructure', task: TASK })
    expect(control.halted).toBe(true)
    // Nothing was prepared or dispatched behind the refusal.
    expect(calls).toEqual([])
    expect(task.handoff).toBeDefined()
  })

  test('the pause records no policy digest, and a readable policy pauses nothing', async () => {
    const unreadable = await liveTaskInput(
      { task: TASK, agent: 'claude', dryRun: false },
      '/repo',
      '/runtime',
      'loop-1',
      {
        fetchTitle: () => 'A task',
        fetchLabels: () => [],
        policy: () => {
          throw new Error('unreadable')
        },
        forge: {
          findOpenPrForBranch: () => null,
          fetchFrozenBrief: () => 'brief',
          resolveIssueObjectives: () => ({ text: '', objectives: [], version: 'objectives' }) as never,
          fetchNewestIssueRulingOrdinal: () => 0
        }
      }
    )
    expect(unreadable.inputVersions?.()).toMatchObject({ policyDigest: 'unknown' })

    const readable = setup({ reviewPolicy: () => ({}) as never })
    expect((await readable.run('vinaya.prepare-run')).exitCode).toBe(0)
    expect(readable.recorded.calls).toEqual([])
    expect(readable.control.halted).toBe(false)
  })
})

describe('prepare-run removes stale reviewer candidates', () => {
  test('a candidate and a scratch copy a prior run left are gone before any agent step; a verdict is kept', async () => {
    const { run, runtimeDir } = setup()
    const round = join(runtimeDir, 'tasks-execution', String(TASK), 'rounds', '2')
    mkdirSync(join(round, 'candidate'), { recursive: true })
    mkdirSync(join(round, 'reviewer-scratch'), { recursive: true })
    writeFileSync(join(round, 'candidate', 'stale.ts'), 'old\n')
    writeFileSync(join(round, 'reviewer-verdict.md'), 'verdict\n')
    expect((await run('vinaya.prepare-run')).exitCode).toBe(0)
    expect(existsSync(join(round, 'candidate'))).toBe(false)
    expect(existsSync(join(round, 'reviewer-scratch'))).toBe(false)
    expect(existsSync(join(round, 'reviewer-verdict.md'))).toBe(true)
  })
})

describe('prepare-run verifies the enforcement controls', () => {
  test('a disabled local gate pauses before any dispatch, naming the control and its remedy', async () => {
    const setupped = setup()
    setupped.task.bound = { ...setupped.task.bound, localGateControl: () => missingGate }
    const result = await setupped.run('vinaya.prepare-run')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("enforcement control 'local-gate' is inactive")
    expect(result.stdout).toContain('run `vinaya install`.')
    expect(paused(setupped.runtimeDir)).toMatchObject({ reason: 'infrastructure' })
    expect(setupped.control.halted).toBe(true)
    // No readiness check, worktree or probe ran behind the refusal.
    expect(setupped.calls).toEqual([])
  })
})

// The run's first two steps on the Engine runner: prepare-run, then a step that reads the task worktree.
const PREPARE_FLOW = `schema_version: "2.0"
id: prepare-flow
display_name: Prepare
description: Prepare-run, then a read of the worktree.
experimental: true
benchmarked: false
defaults:
  model: process-supplied
agents: []
steps:
  - { id: prepare-run, type: mechanical, action: vinaya.prepare-run }
  - { id: read-worktree, type: mechanical, action: test.read-worktree }
`

/** Runs PREPARE_FLOW on the Engine runner until prepare-run refuses, fixes the cause, then resumes the run. */
async function refuseThenResume(refuse: (task: TaskInput) => void, fix: (task: TaskInput) => void) {
  const folder = mkdtempSync(join(tmpdir(), 'prepare-run-flow-'))
  writeFileSync(join(folder, 'flow.yaml'), PREPARE_FLOW)
  mkdirSync(join(folder, 'worker'))
  writeFileSync(join(folder, 'worker', 'grants.yaml'), 'role: worker\n')
  writeFileSync(join(folder, 'process.yaml'), 'id: prepare\nversion: "1"\nflow: flow.yaml\nroles:\n  - worker\n')
  const setupped = setup()
  const { task, calls, runtimeDir } = setupped
  task.bound = {
    ...task.bound,
    // The fake creates the worktree the later step reads.
    createTaskWorktree: () => {
      calls.push('worktree')
      mkdirSync(task.worktreePath, { recursive: true })
    }
  }
  refuse(task)
  const reads: boolean[] = []
  const prepareRun = createActions(task)['vinaya.prepare-run'] as ProcessAction
  const options: ProcessRunOptions = {
    process: loadProcess(folder),
    question: 'task 10',
    bindings: {
      actions: {
        'vinaya.prepare-run': (context) => prepareRun(context),
        'test.read-worktree': () => {
          reads.push(existsSync(task.worktreePath))
          return { exitCode: existsSync(task.worktreePath) ? 0 : 1 }
        }
      },
      decisions: {},
      roles: {}
    },
    checkpointer: new MemorySaver(),
    workingDirectoryRoot: folder,
    control: setupped.control
  }
  const paused = await startProcessRun(options)
  const pausedCalls = [...calls]
  fix(task)
  // The resume is a fresh leg: its own control, and a handoff that halts it.
  const control = createRunControl()
  task.handoff = handoffFor(runtimeDir, control, setupped.recorded)
  const resumed = await resumeProcessRun({ ...options, control }, paused.identity)
  return { paused, pausedCalls, resumed, reads, calls, setupped }
}

describe('a refused prepare-run runs again when the Engine run resumes', () => {
  test('inactive enforcement controls refuse; once fixed, the resume runs prepare-run and creates the worktree', async () => {
    const run = await refuseThenResume(
      (task) => {
        task.bound = { ...task.bound, localGateControl: () => missingGate }
      },
      (task) => {
        task.bound = { ...task.bound, localGateControl: () => activeGate }
      }
    )
    expect(run.paused.reason).toBe('paused')
    // Nothing read the worktree behind the refusal, and the refusal was not recorded as prepare-run's result.
    expect(run.pausedCalls).toEqual([])
    if (run.paused.reason === 'paused') expect(run.paused.checkpoint?.results['prepare-run']).toBeUndefined()
    expect(run.resumed.reason).toBe('completed')
    expect(run.calls).toEqual(['readiness', 'worktree'])
    // The worktree existed before the later step read it.
    expect(run.reads).toEqual([true])
  })

  test('an unready dispatch pauses instead of running on; once ready, the resume creates the worktree', async () => {
    let ready = false
    let readinessChecks = 0
    const run = await refuseThenResume(
      (task) => {
        task.bound = {
          ...task.bound,
          checkTaskDispatchReadiness: () => {
            readinessChecks += 1
            return ready ? { ready: true, output: 'ready' } : { ready: false, output: 'task 9 has not merged' }
          }
        }
      },
      () => {
        ready = true
      }
    )
    expect(run.paused.reason).toBe('paused')
    expect(run.pausedCalls).toEqual([])
    expect(run.setupped.recorded.calls).toContain('pause-state:escalation')
    expect(run.resumed.reason).toBe('completed')
    expect(readinessChecks).toBe(2)
    expect(run.calls).toEqual(['worktree'])
    expect(run.reads).toEqual([true])
  })
})

describe('prepare-run proves the agent sandbox', () => {
  for (const vendor of ['claude-code', 'codex'] as const) {
    test(`a probe that cannot run a command pauses sandbox_refused for the Operator (${vendor})`, async () => {
      const generatedRoot = mkdtempSync(join(tmpdir(), 'prepare-run-roles-'))
      const launchers = createRoleLaunchers({ vendor, generatedRoot })
      const probed: SandboxProbePlan[] = []
      const setupped = setup()
      setupped.task.sandboxPlan = () =>
        sandboxProbePlanFor(vendor, launchers.developer!, join(generatedRoot, 'developer'), setupped.task.worktreePath)
      setupped.task.bound = {
        ...setupped.task.bound,
        probeAgentSandbox: async (plan) => {
          setupped.calls.push('probe')
          probed.push(plan)
          return { ok: false, error: 'bwrap: No permissions to create new namespace' }
        }
      }
      const result = await setupped.run('vinaya.prepare-run')
      expect(result.exitCode).toBe(1)
      // The plan has the shape of the launch the Engine generated for this vendor.
      expect(probed).toHaveLength(1)
      expect(probed[0]?.agent).toBe(vendor === 'claude-code' ? 'claude' : 'codex')
      if (probed[0]?.agent === 'claude')
        expect(probed[0].settingsPath).toBe(join(generatedRoot, 'developer', 'role-settings.json'))
      else if (probed[0]?.agent === 'codex') expect(probed[0].configToml).toContain('sandbox_mode')
      // The probe ran after the worktree and before any agent step.
      expect(setupped.calls).toEqual(['readiness', 'worktree', 'probe'])
      const held = paused(setupped.runtimeDir)
      expect(held).toMatchObject({ reason: 'sandbox_refused', infrastructureRetries: 0 })
      expect(isHostRepairPause(held!.reason)).toBe(true)
      expect(held!.detail).toContain('No permissions to create new namespace')
      expect(held!.detail).toBe(
        new DispatchSandboxRefused(
          { agent: probed[0]!.agent, error: 'bwrap: No permissions to create new namespace' },
          `task ${TASK}`
        ).message
      )
      expect(setupped.recorded.calls).toEqual([
        'escalation:sandbox_refused',
        'pause-state:sandbox_refused',
        'comment:issue:sandbox_refused'
      ])
      expect(setupped.control.halted).toBe(true)
    })
  }

  test('a probe that runs a command lets the run on', async () => {
    const setupped = setup({ sandboxPlan: () => ({ agent: 'claude' }) as never })
    expect((await setupped.run('vinaya.prepare-run')).exitCode).toBe(0)
    expect(setupped.calls).toEqual(['readiness', 'worktree', 'probe'])
    expect(setupped.recorded.calls).toEqual([])
  })
})

const source = (overrides: Partial<PreparedSource>): PreparedSource => ({
  sourceId: URL_SOURCE,
  canonicalUri: URL_SOURCE,
  requirementText: URL_SOURCE,
  governs: 'hooks',
  objectiveIds: [1],
  retrievedAt: '2026-10-14T00:00:00.000Z',
  versionOrRevision: null,
  contentDigest: 'sha256:abc',
  mediaType: 'text/markdown',
  deliveryMode: 'retrieval_tool',
  snapshotRef: null,
  freshnessPolicy: 'pinned',
  trustClassification: 'public_web_untrusted',
  ...overrides
})

const manifestOf = (sources: PreparedSource[]) => ({ round: 1, sources }) as unknown as RequiredSourceManifest

describe('prepare-sources pauses on a source it cannot read', () => {
  test('an unreadable source pauses missing_source before the Developer is dispatched', async () => {
    const unreadable = source({
      deliveryMode: 'unavailable',
      contentDigest: null,
      unavailable: { reason: 'login_required', detail: 'the page asks for a sign-in' }
    })
    const setupped = setup({
      prepareSources: async () => ({ manifest: manifestOf([unreadable]), unavailable: [unreadable] })
    })
    const result = await setupped.run('vinaya.prepare-sources')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(`${URL_SOURCE} (login_required: the page asks for a sign-in)`)
    const held = paused(setupped.runtimeDir)
    expect(held).toMatchObject({ reason: 'missing_source' })
    expect(isHostRepairPause(held!.reason)).toBe(false)
    expect(setupped.recorded.calls).toEqual([
      'escalation:missing_source',
      'pause-state:missing_source',
      'comment:issue:missing_source'
    ])
    expect(setupped.control.halted).toBe(true)
    // The turn is never judged against sources it was not given.
    expect(setupped.task.developerContext.requiredSources).toEqual([])
  })

  test('a missing worktree pauses as an infrastructure stop naming its path, never as a missing source', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'prepare-sources-gone-')), 'worktree')
    const setupped = setup({
      prepareSources: async () => {
        throw new SourceReaderUnavailable(missing, 'the worktree does not exist')
      }
    })
    const result = (await setupped.run('vinaya.prepare-sources')) as Result & { refused?: boolean }
    expect(result.exitCode).toBe(1)
    expect(result.refused).toBe(true)
    expect(result.stdout).toContain(missing)
    const held = paused(setupped.runtimeDir)
    expect(held).toMatchObject({ reason: 'infrastructure' })
    expect(held!.detail).toContain(missing)
    expect(setupped.recorded.calls).not.toContain('pause-state:missing_source')
    expect(setupped.control.halted).toBe(true)
  })

  test('readable sources become the sources the Developer turn is judged against', async () => {
    const setupped = setup({
      prepareSources: async () => ({ manifest: manifestOf([source({})]), unavailable: [] })
    })
    const result = await setupped.run('vinaya.prepare-sources')
    expect(result).toEqual({ exitCode: 0, stdout: 'revision-1' })
    expect(setupped.task.developerContext.requiredSources).toEqual([URL_SOURCE])
    expect(setupped.recorded.calls).toEqual([])
  })
})

describe('an empty fetch issues no source receipt on the Engine path', () => {
  const page = (body: string): FetchDocumentationDeps => ({
    resolve: async () => [{ address: '93.184.215.14', family: 4 }],
    request: async () => ({
      status: 200,
      headers: { 'content-type': 'text/markdown' },
      body: new TextEncoder().encode(body),
      framed: true
    }),
    now: () => new Date('2026-10-14T00:00:00.000Z')
  })
  const completedTurn = {
    turnResult: {
      schemaVersion: 1,
      status: 'completed',
      summary: 'Done.',
      confidence: 90,
      confidenceExplanation: 'Tested.',
      addressedFindingIds: [],
      sourceUses: [{ source: URL_SOURCE, use: 'read the hooks page' }],
      reportedChecks: null
    }
  }

  const fetchThenValidate = async (body: string) => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'prepare-run-fetch-'))
    const live = engineLiveDevToolsContext({
      recordLaunch: () => 'test-run',
      completeLaunch: () => {},
      branch: BRANCH,
      worktreePath: '/worktree',
      task: TASK,
      runtimeDir,
      agent: 'claude',
      repo: null,
      round: () => 1,
      deps: { ...fakeDeps(makeWorld()), fetchDocumentationDeps: page(body) }
    })
    const fetched = await live.context.fetchDocumentation({ url: URL_SOURCE })
    const setupped = setup({
      runtimeDir,
      developerContext: { knownFindingIds: [], requiredSources: [URL_SOURCE] },
      reviewRound: () => 1
    })
    setupped.task.bound = { ...setupped.task.bound, findOpenPrForBranch: () => ({ number: 70, branch: BRANCH }) }
    const validate = () =>
      (createActions(setupped.task)['vinaya.validate-developer-output'] as unknown as Action)({
        results: { develop: { kind: 'agent-spawn', nodeId: 'develop', exitCode: 0, events: [completedTurn] } }
      } as never)
    return { fetched, runtimeDir, validate }
  }

  test('an empty body records no receipt, and a completed turn citing the source is rejected', async () => {
    const { fetched, runtimeDir, validate } = await fetchThenValidate('')
    expect(fetched.ok).toBe(true)
    if (fetched.ok) expect(fetched.result.receipt).toMatchObject({ recorded: false })
    expect(existsSync(sourceReceiptsPath(developerSourceStoreDir(runtimeDir, TASK)))).toBe(false)
    // Rejected, never thrown: the turn is sent back for its one correction, naming the missing receipt.
    const rejected = (await validate()) as { exitCode: number; stdout: string }
    expect(rejected.exitCode).toBe(1)
    const record = JSON.parse(rejected.stdout) as { sendBack: { kind: string; failures: string[] } }
    expect(record.sendBack.kind).toBe('correction')
    expect(record.sendBack.failures.join(' ')).toContain('no delivery receipt the controller recorded')
  })

  test('real content records a receipt, and the citation is accepted', async () => {
    const { fetched, runtimeDir, validate } = await fetchThenValidate(`# Hooks\n\n${'Documentation. '.repeat(100)}`)
    expect(fetched.ok).toBe(true)
    if (fetched.ok) expect(fetched.result.receipt).toMatchObject({ recorded: true })
    expect(existsSync(sourceReceiptsPath(developerSourceStoreDir(runtimeDir, TASK)))).toBe(true)
    expect(await validate()).toMatchObject({ exitCode: 0 })
  })
})
