import { describe, expect, test } from 'bun:test'
import { MemorySaver } from '@langchain/langgraph'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { parse } from 'yaml'
import { assessRound } from '@attalabs/aeg-core'
import { createRunControl, type RunOutcome, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import {
  resumeProcessRun,
  startProcessRun,
  type ActionRegistry,
  type ProcessRunOptions
} from '../../../harness/dev-process/engine-runtime/run-process'
import {
  checkTaskDispatchReadiness,
  createTaskWorktree,
  fetchSourceRevision,
  findOpenPrForBranch
} from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { publishRound } from '../../../apps/cli/src/lib/dev-review-loop/publication'
import { defaultRunWorktreeChecks, handoffFindings } from '../../../apps/cli/src/lib/dev-review-loop'
import { parseDeveloperTurnResult } from '../../../apps/cli/src/lib/developer-turn-result'
import { parseReviewResult } from '../../../apps/cli/src/lib/review-result'
import {
  ACTION_BINDINGS,
  classifyGateResult,
  createActions,
  createRoleLaunchers,
  decisions,
  dispatchReviewers,
  type TaskInput
} from '../executing/actions'

const processFolder = resolve(import.meta.dir, '..')
const loaded = loadProcess(processFolder)

interface FlowStep {
  id: string
  type: string
  action?: string
  role?: string
  decision?: unknown
}
const steps = (parse(readFileSync(loaded.flowPath, 'utf8')) as { steps: FlowStep[] }).steps
const STEP_IDS = steps.map((step) => step.id)

describe('bindings cover the Flow', () => {
  test('every mechanical action, decision and role has an entry', () => {
    const actionNames = steps.flatMap((step) => (step.type === 'mechanical' && step.action ? [step.action] : []))
    expect(actionNames.filter((name) => !Object.hasOwn(ACTION_BINDINGS, name))).toEqual([])
    const decisionIds = steps.flatMap((step) => (step.decision ? [step.id] : []))
    expect(decisionIds.filter((id) => !Object.hasOwn(decisions, id))).toEqual([])
    const roles = createRoleLaunchers({ vendor: 'claude-code', generatedRoot: mkdtempSync(`${tmpdir()}/roles-`) })
    const flowRoles = steps.flatMap((step) => (step.type === 'agent' && step.role ? [step.role] : []))
    expect(flowRoles.filter((role) => !Object.hasOwn(roles, role))).toEqual([])
    expect(Object.keys(roles).sort()).toEqual(['code-reviewer', 'developer', 'security-reviewer'])
  })

  test('each loop-backed entry records the function it adapts', () => {
    const adapts = (name: string) => ACTION_BINDINGS[name]?.adapts
    expect(adapts('vinaya.prepare-run')).toEqual([checkTaskDispatchReadiness, createTaskWorktree])
    expect(adapts('vinaya.prepare-run')?.[0]).toBe(checkTaskDispatchReadiness)
    expect(adapts('vinaya.prepare-run')?.[1]).toBe(createTaskWorktree)
    expect(adapts('vinaya.reconcile-external-state')?.[0]).toBe(findOpenPrForBranch)
    expect(adapts('vinaya.prepare-sources')?.[0]).toBe(fetchSourceRevision)
    expect(adapts('vinaya.validate-developer-output')?.[0]).toBe(parseDeveloperTurnResult)
    expect(adapts('harness.run-gates')?.[0]).toBe(defaultRunWorktreeChecks)
    expect(adapts('vinaya.validate-reviewer-outputs')?.[0]).toBe(parseReviewResult)
    expect(adapts('vinaya.assess-round')?.[0]).toBe(assessRound)
    expect(adapts('vinaya.build-revision-handoff')?.[0]).toBe(handoffFindings)
    expect(adapts('harness.publish')?.[0]).toBe(publishRound)
    expect(adapts('vinaya.classify-gate-result')?.[0]).toBe(classifyGateResult)
    expect(adapts('vinaya.dispatch-reviewers')?.[0]).toBe(dispatchReviewers)
  })
})

describe('bindings read run state when their step runs', () => {
  const review = (role: string) => ({
    reviewResult: {
      schemaVersion: 1,
      role,
      status: 'completed',
      headSha: 'abc123',
      manifestDigest: 'digest',
      summary: 'ok',
      findings: [],
      objectiveResults: []
    }
  })
  const agentResult = (output: unknown) =>
    ({ kind: 'agent-spawn', nodeId: 'x', exitCode: 0, events: [output] }) as never

  test('publish receives the pull request number and head found when it runs', () => {
    const published: Array<{ root: string; input: Record<string, unknown> }> = []
    let prNumber: number | null = null
    const task = {
      root: '/repo',
      branch: 'task/issue-9',
      issueNumber: 9,
      worktreePath: '/repo/.worktrees/task/issue-9',
      reviewRound: () => 2,
      publish: (at: Record<string, unknown>) => ({ task: 9, ...at }),
      bound: {
        findOpenPrForBranch: (branch: string) => (branch === 'task/issue-9' && prNumber ? { number: prNumber } : null),
        readWorktreeHead: (path: string) => (path === '/repo/.worktrees/task/issue-9' ? 'abc123' : null),
        publishRound: (root: string, input: Record<string, unknown>) => void published.push({ root, input })
      }
    } as unknown as TaskInput
    const publish = createActions(task)['harness.publish'] as (context: never) => unknown
    expect(() => publish({} as never)).toThrow('no open pull request')
    // The pull request is opened after the task started, before the publish step runs.
    prNumber = 4242
    publish({} as never)
    expect(published).toEqual([{ root: '/repo', input: { task: 9, prNumber: 4242, expectedHead: 'abc123', round: 2 } }])
  })

  test('validating the reviewer outputs holds both verdicts for the round in progress', () => {
    const held: Array<[number, number, string, string]> = []
    const task = {
      root: '/repo',
      issueNumber: 9,
      reviewRound: () => 3,
      renderVerdict: (role: string) => `rendered ${role}`,
      bound: {
        writeHeldVerdict: (_root: string, issue: number, round: number, role: string, text: string) =>
          void held.push([issue, round, role, text])
      }
    } as unknown as TaskInput
    const validate = createActions(task)['vinaya.validate-reviewer-outputs'] as (context: never) => unknown
    const results = {
      'code-review': agentResult(review('code-reviewer')),
      'security-review': agentResult(review('security-reviewer'))
    }
    validate({ results } as never)
    expect(held).toEqual([
      [9, 3, 'reviewer', 'rendered reviewer'],
      [9, 3, 'security', 'rendered security']
    ])
  })

  test('an invalid reviewer output holds nothing', () => {
    const held: unknown[] = []
    const task = {
      reviewRound: () => 1,
      renderVerdict: () => '',
      bound: { writeHeldVerdict: () => void held.push(1) }
    } as unknown as TaskInput
    const validate = createActions(task)['vinaya.validate-reviewer-outputs'] as (context: never) => unknown
    const results = { 'code-review': agentResult(review('code-reviewer')), 'security-review': agentResult({}) }
    expect(() => validate({ results } as never)).toThrow('security-review output failed')
    expect(held).toEqual([])
  })
})

const STEP_OF_ROLE: Record<string, string> = {
  developer: 'develop',
  'code-reviewer': 'code-review',
  'security-reviewer': 'security-review'
}

interface Scenario {
  /** Exit codes the gate step reports in turn; the last repeats. */
  gates?: number[]
  /** Exit codes the assessment step reports in turn (non-zero asks for a revision); the last repeats. */
  assessments?: number[]
  /** Spawns for these roles never exit on their own. */
  hang?: string[]
  onSpawn?: (role: string) => void
  onAction?: (step: string) => void
}

function setup(scenario: Scenario = {}) {
  const stepCalls: Record<string, number> = Object.fromEntries(STEP_IDS.map((id) => [id, 0]))
  const spawns: string[] = []
  const killed: string[] = []
  const gates = [...(scenario.gates ?? [0])]
  const assessments = [...(scenario.assessments ?? [0])]
  const next = (queue: number[]) => (queue.length > 1 ? (queue.shift() as number) : (queue[0] ?? 0))

  const real = createActions({} as TaskInput)
  const actions: ActionRegistry = Object.fromEntries(
    Object.keys(ACTION_BINDINGS).map((name) => [
      name,
      async (context) => {
        stepCalls[context.nodeId] = (stepCalls[context.nodeId] ?? 0) + 1
        scenario.onAction?.(context.nodeId)
        if (name === 'harness.run-gates') return { exitCode: next(gates) }
        if (name === 'vinaya.assess-round') return { exitCode: next(assessments) }
        if (name === 'vinaya.classify-gate-result' || name === 'vinaya.dispatch-reviewers') {
          return (real[name] as NonNullable<ActionRegistry[string]>)(context)
        }
        return { exitCode: 0 }
      }
    ])
  )

  const generatedRoot = mkdtempSync(`${tmpdir()}/flow-roles-`)
  const roles = createRoleLaunchers({ vendor: 'claude-code', generatedRoot })
  const spawnFn: ProcessRunOptions['spawnFn'] = (_command, args) => {
    const settings = args[args.indexOf('--settings') + 1] ?? ''
    const role = basename(dirname(settings))
    spawns.push(role)
    const step = STEP_OF_ROLE[role] ?? role
    stepCalls[step] = (stepCalls[step] ?? 0) + 1
    scenario.onSpawn?.(role)
    return fakeAgent(role, scenario.hang?.includes(role) ?? false, () => killed.push(role))
  }

  const options: ProcessRunOptions = {
    process: loaded,
    question: 'the task',
    bindings: { actions, decisions, roles },
    checkpointer: new MemorySaver(),
    workingDirectoryRoot: mkdtempSync(`${tmpdir()}/flow-root-`),
    spawnFn
  }
  return { options, stepCalls, spawns, killed }
}

function fakeAgent(_role: string, hang: boolean, onKill: () => void): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () => {
        if (hang) return
        setTimeout(() => {
          stdout?.('{"type":"result"}\n')
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: {
      on: (_event, listener) => {
        stdout = listener as (chunk: string) => void
      }
    },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {
      onKill()
      for (const listener of closeListeners) listener(null)
    }
  }
}

const everyStepOnce = Object.fromEntries(STEP_IDS.map((id) => [id, 1]))

function completedSteps(outcome: RunOutcome): string[] {
  return outcome.reason === 'completed' || outcome.reason === 'exhausted' ? Object.keys(outcome.checkpoint.results) : []
}

describe('the Vinaya Flow on the Engine, with stub agents', () => {
  test('green path ends at publish-ready-for-merge', async () => {
    const { options, stepCalls } = setup()
    const outcome = await startProcessRun(options)
    expect(outcome.reason).toBe('completed')
    expect(stepCalls).toEqual(everyStepOnce)
    expect(completedSteps(outcome)).toContain('publish-ready-for-merge')
  })

  test('a red gate loops back to develop once, then goes green', async () => {
    const { options, stepCalls } = setup({ gates: [1, 0] })
    const outcome = await startProcessRun(options)
    expect(outcome.reason).toBe('completed')
    expect(stepCalls.develop).toBe(2)
    expect(stepCalls['run-mechanical-gates']).toBe(2)
    expect(stepCalls['code-review']).toBe(1)
    expect(stepCalls['publish-ready-for-merge']).toBe(1)
  })

  test('an assessment asking for revision loops back to develop once, then is clean', async () => {
    const { options, stepCalls } = setup({ assessments: [1, 0] })
    const outcome = await startProcessRun(options)
    expect(outcome.reason).toBe('completed')
    expect(stepCalls.develop).toBe(2)
    expect(stepCalls['code-review']).toBe(2)
    expect(stepCalls['assess-round']).toBe(2)
    expect(stepCalls['publish-ready-for-merge']).toBe(1)
  })

  test('two revisions in a row still complete, counted by the executor', async () => {
    const { options, stepCalls } = setup({ assessments: [1, 1, 0] })
    const outcome = await startProcessRun(options)
    expect(outcome.reason).toBe('completed')
    expect(stepCalls.develop).toBe(3)
  })

  test('gates that never go green exhaust the revision ceiling before any reviewer runs', async () => {
    const { options, stepCalls, spawns } = setup({ gates: [1] })
    const outcome = await startProcessRun(options)
    expect(outcome.reason).toBe('exhausted')
    expect(stepCalls.develop).toBe(4)
    expect(spawns.filter((role) => role !== 'developer')).toEqual([])
    expect(stepCalls['code-review']).toBe(0)
    expect(stepCalls['security-review']).toBe(0)
  })

  test('a halt during a sequential step pauses the run, and a resume does not replay finished steps', async () => {
    const control = createRunControl()
    const { options, stepCalls } = setup({
      onAction: (step) => {
        if (step === 'validate-developer-output') control.halt('stop here')
      }
    })
    options.control = control
    const paused = await startProcessRun(options)
    expect(paused.reason).toBe('paused')
    const before = [
      'prepare-run',
      'reconcile-external-state',
      'prepare-sources',
      'develop',
      'validate-developer-output'
    ]
    for (const step of before) expect(stepCalls[step]).toBe(1)
    expect(stepCalls['run-mechanical-gates']).toBe(0)

    const resumed = await resumeProcessRun({ ...options, control: undefined }, paused.identity)
    expect(resumed.reason).toBe('completed')
    expect(stepCalls).toEqual(everyStepOnce)
  })

  test('a cancel while the developer agent runs aborts its signal and does not complete', async () => {
    const abort = new AbortController()
    const control = createRunControl(abort.signal)
    const { options, killed, stepCalls } = setup({
      hang: ['developer'],
      onSpawn: () => queueMicrotask(() => abort.abort(new Error('cancelled by the test')))
    })
    options.control = control
    const outcome = await startProcessRun(options)
    expect(outcome.reason).not.toBe('completed')
    expect(control.signal.aborted).toBe(true)
    expect(killed).toEqual(['developer'])
    expect(stepCalls['run-mechanical-gates']).toBe(0)
  })
})
