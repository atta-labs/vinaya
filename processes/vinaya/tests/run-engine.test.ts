import { describe, expect, test } from 'bun:test'
import { recordedHandoff } from './handoff-fakes'
import { PASSING_FORGE_GATES } from './round-fakes'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { failedCheckLogsOnHead } from '../../../apps/cli/src/lib/dev-review-loop'
import { gitObjectReader, prepareSources } from '../../../apps/cli/src/lib/source-provider'
import { sourceReceiptsPath } from '../../../apps/cli/src/lib/source-manifest'
import type { FetchDocumentationDeps } from '../../../apps/cli/src/lib/task-tools/fetch-documentation'
import { taskControlDir } from '../../../apps/cli/src/lib/worker-boundary'
import {
  BASE,
  BRANCH,
  brokerPush,
  fakeDeps,
  makeWorld,
  OUTSIDE,
  OWN,
  WORKFLOW,
  type World
} from '../../../apps/cli/tests/lib/task-tools/live-developer-context-world'
import { developerPrompt } from '../executing/developer-prompt'
import { createRoleLaunchers } from '../executing/actions'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import type { ActionRegistry } from '../../../harness/dev-process/engine-runtime/run-process'
import type { NodeLifecycle } from '../../../harness/dev-process/logging/translate'
import { devToolsSocketPath } from '../../../apps/cli/src/lib/task-tools/dev-tools-registration'
import {
  classifyDeveloperOutput,
  classifyGateResult,
  classifyReviewerOutputs,
  createActions,
  dispatchReviewers,
  type TaskInput
} from '../executing/actions'
import { heldVerdictPath, writeHeldVerdict } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { MAX_AUTOMATIC_CONFLICT_REENTRIES } from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { loopLogPathFor } from '../../../apps/cli/src/lib/loop-log'
import { SqliteCheckpointer } from '../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import { currentRunGeneration, runIdentityOfTask } from '../bin/run-lifecycle'
import type { DeveloperPromptFacts } from '../executing/developer-prompt'
import {
  checkpointPath,
  createTraceRecorder,
  tracedActions,
  developerSourceStoreDir,
  dryRunLines,
  withReviewerWorkingDirectory,
  engineLiveDevToolsContext,
  liveTaskInput,
  parseArgs,
  runEngine,
  shimContent,
  type EngineRunOptions,
  type RunTrace,
  targetRepoRoot
} from '../bin/run-engine'

const loaded = loadProcess(resolve(import.meta.dir, '..'))
const repoRoot = resolve(import.meta.dir, '../../..')

describe('arguments', () => {
  test('a task number and an agent are required', () => {
    expect(parseArgs(['--task', '12', '--agent', 'codex'])).toEqual({ task: 12, agent: 'codex', dryRun: false })
    expect(parseArgs(['--task', '3', '--agent', 'claude', '--dry-run']).dryRun).toBe(true)
    expect(() => parseArgs(['--task', '3'])).toThrow('Usage')
    expect(() => parseArgs(['--task', 'x', '--agent', 'claude'])).toThrow('positive integer')
    expect(() => parseArgs(['--task', '3', '--agent', 'gemini'])).toThrow('claude or codex')
  })

  test('--model names the model for process-supplied grants', () => {
    expect(parseArgs(['--task', '1', '--agent', 'codex', '--model', 'gpt-x'])).toEqual({
      task: 1,
      agent: 'codex',
      dryRun: false,
      model: 'gpt-x'
    })
    expect(parseArgs(['--task', '1', '--agent', 'codex'])).not.toHaveProperty('model')
    expect(() => parseArgs(['--task', '1', '--agent', 'codex', '--model'])).toThrow('--model takes a model id')
    expect(() => parseArgs(['--task', '1', '--agent', 'codex', '--model', '--dry-run'])).toThrow(
      '--model takes a model id'
    )
  })
})

describe('the dry run', () => {
  for (const agent of ['claude', 'codex'] as const) {
    test(`prints the digest, the steps, the bound functions and each role's launch (${agent})`, async () => {
      const lines = await dryRunLines({
        process: loaded,
        agent,
        generatedRoot: mkdtempSync(join(tmpdir(), 'dry-run-')),
        shimPath: '/runs/1/dev-bridge.sh'
      })
      expect(lines[0]).toBe(`process ${loaded.identity.id}@${loaded.identity.version} digest ${loaded.digest}`)
      expect(lines.filter((line) => line.startsWith('step '))).toHaveLength(27)
      const bound = lines.filter((line) => line.startsWith('bound '))
      expect(bound).toHaveLength(24)
      expect(bound).toContain(
        'bound check-publish-mergeability vinaya.check-publish-mergeability: pollMergeableState, fetchConflictingFiles, discardHeldVerdicts'
      )
      expect(bound).toContain(
        'bound check-mergeability vinaya.check-mergeability: pollMergeableState, fetchConflictingFiles, assessRound'
      )
      expect(bound).toContain('bound read-forge-ci vinaya.read-forge-ci: fetchCiConclusion, rerunFailedWorkflowJobs')
      expect(bound).toContain('bound check-premise vinaya.check-premise: checkPremiseAtHead')
      expect(bound).toContain(
        'bound publish-ready-for-merge harness.publish: publishRound, upsertDeferredFindingsIssue'
      )
      expect(bound).toContain(
        'bound validate-reviewer-outputs vinaya.validate-reviewer-outputs: classifyReviewOutcome, writeHeldVerdict, buildManifestRecord'
      )
      const launches = lines.filter((line) => line.startsWith('launch '))
      expect(launches.map((line) => line.split(':')[0])).toEqual([
        'launch developer',
        'launch code-reviewer',
        'launch security-reviewer'
      ])
      for (const launch of launches) expect(launch).toContain(agent === 'claude' ? 'claude' : 'codex')
      expect(lines.filter((line) => line.startsWith('shim '))).toEqual([
        'shim developer: /runs/1/dev-bridge.sh',
        'shim code-reviewer: /runs/1/dev-bridge.sh',
        'shim security-reviewer: /runs/1/dev-bridge.sh'
      ])
    })
  }
})

describe('the relay shim', () => {
  test('execs the repository CLI bridge on the host socket', () => {
    expect(shimContent('/tmp/x/s.sock', '/usr/bin/bun', '/repo/apps/cli/src/index.ts')).toBe(
      "#!/bin/sh\nexec '/usr/bin/bun' '/repo/apps/cli/src/index.ts' task-tools dev-bridge --socket '/tmp/x/s.sock'\n"
    )
  })

  test('quotes a path that holds a quote', () => {
    expect(shimContent("/tmp/it's/s.sock", '/bun', '/e.ts')).toContain(`'/tmp/it'\\''s/s.sock'`)
  })
})

// --- a stub run -------------------------------------------------------------

const STEP_OF_ROLE: Record<string, string> = {
  developer: 'develop',
  'code-reviewer': 'code-review',
  'security-reviewer': 'security-review'
}

function stubAgent(_role: string, lines: string[]): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () => {
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
    kill: () => {
      for (const listener of closeListeners) listener(null)
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
  developer: [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"publish_changes"}]}}',
    '{"type":"result"}'
  ],
  'code-reviewer': ['{"type":"assistant","text":"I will not run that command."}', review('code-reviewer')],
  'security-reviewer': [review('security-reviewer')]
}

function stubRun(scenario: { failAt?: string; haltAt?: string; hostFails?: boolean } = {}): {
  options: EngineRunOptions
  emitted: unknown[]
  calls: string[]
  observed: NodeLifecycle[]
  runtimeDir: string
  handoff: ReturnType<typeof recordedHandoff>
} {
  const calls: string[] = []
  const emitted: unknown[] = []
  const observed: NodeLifecycle[] = []
  const control = createRunControl()
  const runtimeDir = mkdtempSync(join(tmpdir(), 'engine-run-'))
  const actions: ActionRegistry = Object.fromEntries(
    [
      'vinaya.prepare-run',
      'vinaya.reconcile-external-state',
      'vinaya.prepare-sources',
      'vinaya.choose-start',
      'vinaya.validate-developer-output',
      'vinaya.classify-developer-output',
      'harness.run-gates',
      ...Object.keys(PASSING_FORGE_GATES),
      'vinaya.assess-gate',
      'vinaya.classify-gate-result',
      'vinaya.run-security-scan',
      'vinaya.dispatch-reviewers',
      'vinaya.validate-reviewer-outputs',
      'vinaya.classify-reviewer-outputs',
      'vinaya.assess-round',
      'vinaya.build-revision-handoff',
      'vinaya.run-live-checks',
      'vinaya.classify-live-result',
      'harness.publish'
    ].map((name) => [
      name,
      async (context) => {
        if (scenario.haltAt === context.nodeId) control.halt('stop here')
        if (scenario.failAt === context.nodeId) throw new Error('the action broke')
        if (name === 'vinaya.classify-gate-result') return classifyGateResult(context)
        if (name === 'vinaya.classify-developer-output') return classifyDeveloperOutput(context)
        if (name === 'vinaya.classify-reviewer-outputs') return classifyReviewerOutputs(context)
        if (name === 'vinaya.dispatch-reviewers') return dispatchReviewers()
        return { exitCode: 0 }
      }
    ])
  )
  const handoff = recordedHandoff()
  const options: EngineRunOptions = {
    args: { task: 7, agent: 'claude', dryRun: false },
    process: loaded,
    repoRoot,
    runtimeDir,
    loopId: 'loop-under-test',
    taskInput: {
      inputVersions: () => ({ briefHash: null, objectivesVersion: null, rulingOrdinal: 0, policyDigest: 'test' })
    } as unknown as TaskInput,
    handoffDeps: handoff.deps,
    actions,
    sink: {
      log: (event: unknown) => {
        calls.push('log')
        emitted.push(event)
      },
      drain: async () => {
        calls.push('drain')
      }
    },
    startHost: async (host) => {
      calls.push('host-start')
      if (scenario.hostFails) throw new Error('no socket')
      expect(host.socketPath).toBe(devToolsSocketPath(`engine-7-${host.role}`))
      expect(['developer', 'code-reviewer', 'security']).toContain(host.role)
      return { close: async () => void calls.push('host-close') }
    },
    devToolsContext: {} as never,
    observe: (event) => observed.push(event),
    control,
    out: (line) => calls.push(`out:${line}`),
    spawnFn: (_command, args) => {
      const settings = args[args.indexOf('--settings') + 1] ?? ''
      const role = settings.split('/').at(-2) ?? ''
      calls.push(`spawn:${STEP_OF_ROLE[role]}`)
      return stubAgent(role, AGENT_LINES[role] ?? [])
    }
  }
  return { options, emitted, calls, observed, runtimeDir, handoff }
}

const readTrace = (path: string): RunTrace => JSON.parse(readFileSync(path, 'utf8')) as RunTrace

describe('a stub run on the Engine path', () => {
  test('writes the trace: steps in order with exit codes, streaming records as delivered, both verdicts parsed', async () => {
    const { options, observed } = stubRun()
    const result = await runEngine(options)
    expect(result.exitCode).toBe(0)
    expect(result.tracePath).toBe(join(options.runtimeDir, 'engine-runs', '7', 'trace.json'))
    const trace = readTrace(result.tracePath)
    expect(trace.outcome).toBe('completed')
    expect(trace.steps.map((step) => step.nodeId)).toEqual([
      'prepare-run',
      'reconcile-external-state',
      'prepare-sources',
      'choose-start',
      'develop',
      'validate-developer-output',
      'classify-developer-output',
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
    expect(trace.steps.every((step) => step.exitCode === 0)).toBe(true)
    for (const nodeId of ['develop', 'code-review', 'security-review']) {
      const streamed = observed.filter((event) => event.type === 'node:streaming' && event.nodeId === nodeId)
      expect(streamed.length).toBeGreaterThan(0)
      expect(trace.steps.find((step) => step.nodeId === nodeId)?.streaming).toEqual(streamed)
    }
    expect(JSON.stringify(trace.steps.find((step) => step.nodeId === 'develop')?.streaming)).toContain(
      'publish_changes'
    )
    expect(JSON.stringify(trace.steps.find((step) => step.nodeId === 'code-review')?.streaming)).toContain(
      'I will not run that command.'
    )
    expect(trace.verdicts['code-review']).toMatchObject({ ok: true })
    expect(trace.verdicts['security-review']).toMatchObject({ ok: true })
  })

  test('prints the loopId first, hands every event to the sink in order, and drains last', async () => {
    const { options, emitted, calls } = stubRun()
    await runEngine(options)
    expect(calls[0]).toBe('out:loopId loop-under-test')
    expect(emitted.length).toBeGreaterThan(0)
    const lastLog = calls.lastIndexOf('log')
    const drain = calls.indexOf('drain')
    expect(drain).toBeGreaterThan(lastLog)
    expect(calls.filter((call) => call === 'drain')).toHaveLength(1)
    const kinds = emitted.map((event) => `${(event as { kind: string }).kind}.${(event as { event: string }).event}`)
    // The stub assessment records no round, so the only event is the single exit record: no node writes a heartbeat.
    expect(kinds).toEqual(['dev_review_loop.driver_exited'])
  })

  test('starts the host before the Developer and writes the executable shim', async () => {
    const { options, calls } = stubRun()
    const result = await runEngine(options)
    expect(calls.indexOf('host-start')).toBeLessThan(calls.indexOf('spawn:develop'))
    const shim = join(options.runtimeDir, 'engine-runs', '7', 'developer-dev-bridge.sh')
    expect(readFileSync(shim, 'utf8')).toBe(
      shimContent(devToolsSocketPath('engine-7-developer'), process.execPath, join(repoRoot, 'apps/cli/src/index.ts'))
    )
    expect(statSync(shim).mode & 0o111).not.toBe(0)
    expect(result.exitCode).toBe(0)
    const generated = join(options.runtimeDir, 'engine-runs', '7', 'generated', 'developer')
    expect(readFileSync(join(generated, 'role-mcp.json'), 'utf8')).toContain(shim)
  })

  test('keeps the run checkpoints in a SQLite file under the run directory', async () => {
    const { options } = stubRun()
    await runEngine({ ...options, revision: 'rev-under-test' })
    const file = checkpointPath(join(options.runtimeDir, 'engine-runs', '7'))
    expect(statSync(file).size).toBeGreaterThan(0)
    const rows = new Database(file, { readonly: true }).query('SELECT DISTINCT revision FROM checkpoints').all()
    expect(rows).toEqual([{ revision: 'rev-under-test' }])
  })

  test('closes the host and drains the sink when the run succeeds', async () => {
    const { options, calls } = stubRun()
    await runEngine(options)
    expect(calls.filter((call) => call === 'host-close')).toHaveLength(3)
    expect(calls.indexOf('host-close')).toBeLessThan(calls.indexOf('drain'))
  })

  test('closes the host and drains the sink when a step fails', async () => {
    const { options, calls, handoff } = stubRun({ failAt: 'run-mechanical-gates' })
    const result = await runEngine(options)
    // A step that throws is an infrastructure pause the runner halts, not a failed run: records first, then one comment.
    expect(handoff.calls).toEqual([
      'escalation:infrastructure',
      'pause-state:infrastructure',
      'comment:issue:infrastructure'
    ])
    expect(readTrace(result.tracePath).pauseReason).toBe('infrastructure')
    expect(result.exitCode).toBe(2)
    expect(calls.filter((call) => call === 'host-close')).toHaveLength(3)
    expect(calls.filter((call) => call === 'drain')).toHaveLength(1)
    expect(readTrace(result.tracePath).outcome).toBe('paused')
  })

  test('a step whose action throws records its message and stack in the trace', async () => {
    const { options } = stubRun({ failAt: 'run-mechanical-gates' })
    const result = await runEngine(options)
    const failed = readTrace(result.tracePath).steps.find((step) => step.nodeId === 'run-mechanical-gates')
    expect(failed?.exitCode).toBe(1)
    expect(failed?.error).toContain('the action broke')
  })

  test('closes the host and drains the sink when the run pauses', async () => {
    const { options, calls } = stubRun({ haltAt: 'validate-developer-output' })
    const result = await runEngine(options)
    expect(result.exitCode).toBe(2)
    expect(readTrace(result.tracePath).outcome).toBe('paused')
    expect(calls.filter((call) => call === 'host-close')).toHaveLength(3)
    expect(calls.filter((call) => call === 'drain')).toHaveLength(1)
  })

  test('drains the sink when the host cannot start, and launches no agent', async () => {
    const { options, calls } = stubRun({ hostFails: true })
    const result = await runEngine(options)
    expect(result.exitCode).toBe(2)
    expect(calls.filter((call) => call.startsWith('spawn:'))).toEqual([])
    expect(calls.filter((call) => call === 'drain')).toHaveLength(1)
    expect(readTrace(result.tracePath).error).toBe('no socket')
  })
})

// --- the Developer's prompt and the Linux sandbox opt-in ---------------------

const FACTS: DeveloperPromptFacts = {
  brief: '# Frozen brief\nDo the one thing.\n\n**Revision:** abc',
  objectives: { objectives: [{ id: 'O1', text: 'It works' }], version: 'v1' },
  rulings: ['Principal ruling: go on.'],
  rulingOrdinal: 2,
  policy: {
    maxRounds: 4,
    maxTaskMinutes: 90
  } as DeveloperPromptFacts['policy'],
  baseSha: 'b'.repeat(40),
  headSha: 'a'.repeat(40),
  sources: {
    block: 'Required sources:\n- docs/x.md',
    evidence: [{ ref: 'source:docs/x.md', version: 'sha256:1' }]
  },
  round: 1,
  doctrine: 'Developer doctrine: stop when blocked.',
  issueRulings: ['Issue ruling: continue.'],
  keptWork: null,
  resume: { task: 7, branch: 'task/issue-7', worktree: '/repo/.worktrees/task/issue-7', remoteHead: null },
  heldReview: null
}

/** Runs the stub Flow and returns the prompt and environment each agent spawn was given. */
async function spawnedWith(extra: Partial<EngineRunOptions>) {
  const { options } = stubRun()
  const spawned: Array<{
    role: string
    prompt: string
    env: Record<string, string | undefined>
  }> = []
  const inner = options.spawnFn as NonNullable<EngineRunOptions['spawnFn']>
  await runEngine({
    ...options,
    ...extra,
    spawnFn: ((command: string, args: string[], spawnOptions: { env?: Record<string, string | undefined> }) => {
      const child = inner(command, args, spawnOptions as never)
      const settings = args[args.indexOf('--settings') + 1] ?? ''
      const entry = {
        role: settings.split('/').at(-2) ?? '',
        prompt: '',
        env: spawnOptions?.env ?? {}
      }
      spawned.push(entry)
      const stdin = child.stdin as NonNullable<typeof child.stdin>
      const write = stdin.write.bind(stdin)
      stdin.write = ((chunk: string) => {
        entry.prompt += String(chunk)
        return write(chunk)
      }) as typeof stdin.write
      return child
    }) as never
  })
  return spawned
}

describe('a published pull request that falls into conflict with the default branch', () => {
  type Read = { state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' }
  /** A stub run whose first run opens PR #70; each later run attaches to it, and its first mergeability read is the conflict the re-entry answers. */
  function publishedRun(reads: Read[]) {
    const run = stubRun()
    let reconciles = 0
    let conflictToAnswer = false
    const base = run.options.actions!
    run.options.actions = {
      ...base,
      'vinaya.reconcile-external-state': async () => {
        reconciles += 1
        if (reconciles === 1) return { exitCode: 0 }
        conflictToAnswer = true
        return { exitCode: 1, stdout: JSON.stringify({ number: 70 }) }
      },
      'vinaya.check-mergeability': async (context) => {
        if (!conflictToAnswer) return base['vinaya.check-mergeability']!(context)
        conflictToAnswer = false
        return { exitCode: 1 }
      }
    }
    run.options.taskInput = {
      ...run.options.taskInput,
      branch: 'task/issue-7',
      bound: { findOpenPrForBranch: () => ({ number: 70 }) }
    } as unknown as TaskInput
    let read = -1
    const current = () => reads[Math.min(read, reads.length - 1)]!
    run.options.lifecycle = {
      handleSignals: false,
      publishedWatch: {
        fetchPrState: () => {
          read += 1
          return current().state
        },
        fetchMergeableState: () => current().mergeable,
        pollMs: 0,
        sleep: async () => {}
      }
    }
    const generation = () => {
      const saver = new SqliteCheckpointer({
        path: checkpointPath(join(run.runtimeDir, 'engine-runs', '7')),
        revision: 'x'
      })
      try {
        return currentRunGeneration(saver, 7)
      } finally {
        saver.close()
      }
    }
    return { ...run, generation }
  }
  const spawned = (calls: string[], step: string) => calls.filter((call) => call === `spawn:${step}`).length
  const reentries = (emitted: unknown[]) =>
    emitted.filter((event) => (event as { event?: string }).event === 'conflict_reentry') as Array<{ attempt: number }>

  test('a completed run whose pull request turns CONFLICTING starts a fresh run at the Developer, then publishes again', async () => {
    const run = publishedRun([
      { state: 'OPEN', mergeable: 'UNKNOWN' },
      { state: 'OPEN', mergeable: 'CONFLICTING' },
      { state: 'MERGED', mergeable: 'MERGEABLE' }
    ])
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(0)
    // The fresh run attached to the open pull request and dispatched the Developer for the conflict, then both reviews.
    expect(spawned(run.calls, 'develop')).toBe(2)
    expect(spawned(run.calls, 'code-review')).toBe(2)
    expect(spawned(run.calls, 'security-review')).toBe(2)
    const steps = readTrace(result.tracePath).steps.map((step) => step.nodeId)
    expect(steps.filter((step) => step === 'publish-ready-for-merge')).toHaveLength(2)
    // The completed checkpoint was never resumed: the re-entry ran under the next run identity.
    expect(run.generation()).toBe(2)
    expect(reentries(run.emitted)).toEqual([
      expect.objectContaining({ pr: 70, attempt: 1, bound: MAX_AUTOMATIC_CONFLICT_REENTRIES })
    ])
    const driverLog = readFileSync(loopLogPathFor(null, 7, run.runtimeDir), 'utf8')
    expect(driverLog).toContain(`starting a fresh run (${runIdentityOfTask(7, 2).runId})`)
    expect(driverLog).toContain('PR #70 was merged; ending')
  })

  test('a published pull request that is closed ends the runner with no re-entry', async () => {
    const run = publishedRun([{ state: 'CLOSED', mergeable: 'MERGEABLE' }])
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(0)
    expect(spawned(run.calls, 'develop')).toBe(1)
    expect(reentries(run.emitted)).toEqual([])
  })

  test('past the re-entry bound the runner pauses for a person through the ordinary pause, and ends', async () => {
    const run = publishedRun([{ state: 'OPEN', mergeable: 'CONFLICTING' }])
    const result = await runEngine(run.options)
    expect(result.exitCode).toBe(2)
    expect(reentries(run.emitted).map((event) => event.attempt)).toEqual(
      Array.from({ length: MAX_AUTOMATIC_CONFLICT_REENTRIES }, (_, i) => i + 1)
    )
    expect(spawned(run.calls, 'develop')).toBe(MAX_AUTOMATIC_CONFLICT_REENTRIES + 1)
    expect(run.handoff.calls).toEqual([
      'escalation:repeat_failure',
      'pause-state:repeat_failure',
      'comment:pr:repeat_failure'
    ])
    expect(readTrace(result.tracePath).pauseReason).toBe('repeat_failure')
  })
})

describe("the Developer's prompt", () => {
  test('carries the frozen brief, the context packet and the turn-result instruction, not only the task number', async () => {
    const spawned = await spawnedWith({ developerFacts: async () => FACTS })
    const developer = spawned.find((entry) => entry.role === 'developer')
    // The Flow's rendered line is not sent: the loop's Developer receives none.
    expect(developer?.prompt).not.toContain('Develop the task')
    expect(developer?.prompt).toContain('Developer doctrine: stop when blocked.')
    expect(developer?.prompt).toContain('Do the one thing.')
    expect(developer?.prompt).toContain('# Context packet v1')
    expect(developer?.prompt).toContain('Execute only this frozen brief on the task branch.')
    expect(developer?.prompt).toContain('- ruling @ ordinal:2')
    expect(developer?.prompt).toContain('- source:docs/x.md @ sha256:1')
    expect(developer?.prompt).toContain('Required sources:')
    expect(developer?.prompt).toContain('schemaVersion 1')
    // The reviewers are not given the Developer's brief.
    for (const entry of spawned.filter((candidate) => candidate.role !== 'developer'))
      expect(entry.prompt).not.toContain('Do the one thing.')
  })

  test('is read when the step starts', async () => {
    let reads = 0
    await spawnedWith({
      developerFacts: async () => {
        reads += 1
        return FACTS
      }
    })
    expect(reads).toBe(1)
  })
})

describe("the reviewers' prompts", () => {
  test('each reviewer step is given the task input reviewer prompt for its role', async () => {
    const asked: string[] = []
    const reviewerPrompt = (role: 'reviewer' | 'security') => {
      asked.push(role)
      return `STUB PROMPT FOR ${role}`
    }
    const spawned = await spawnedWith({
      developerFacts: async () => FACTS,
      taskInput: { reviewerPrompt } as unknown as TaskInput
    })
    expect(spawned.find((e) => e.role === 'code-reviewer')?.prompt).toBe('STUB PROMPT FOR reviewer')
    expect(spawned.find((e) => e.role === 'security-reviewer')?.prompt).toBe('STUB PROMPT FOR security')
    expect(spawned.find((e) => e.role === 'developer')?.prompt).not.toContain('STUB PROMPT')
    expect(asked.sort()).toEqual(['reviewer', 'security'])
  })
})

describe('the Linux sandbox opt-in', () => {
  const settingsOf = (options: EngineRunOptions, role: string) =>
    JSON.parse(
      readFileSync(join(options.runtimeDir, 'engine-runs', '7', 'generated', role, 'role-settings.json'), 'utf8')
    )

  test('allows Unix sockets in every role sandbox and forwards the variable to the agent', async () => {
    const { options } = stubRun()
    const prior = process.env.VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS
    process.env.VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS = '1'
    try {
      const spawned = await spawnedWith({ allowUnixSockets: true })
      for (const entry of spawned) expect(entry.env.VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS).toBe('1')
    } finally {
      if (prior === undefined) delete process.env.VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS
      else process.env.VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS = prior
    }
    await runEngine({ ...options, allowUnixSockets: true })
    for (const role of ['developer', 'code-reviewer', 'security-reviewer'])
      expect(settingsOf(options, role).sandbox.network.allowAllUnixSockets).toBe(true)
  })

  test('leaves the sandbox as it was without the opt-in', async () => {
    const { options } = stubRun()
    process.env.VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS = '1'
    try {
      const spawned = await spawnedWith({})
      for (const entry of spawned) expect(entry.env.VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS).toBeUndefined()
    } finally {
      delete process.env.VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS
    }
    await runEngine(options)
    expect(settingsOf(options, 'developer').sandbox.network).not.toHaveProperty('allowAllUnixSockets')
  })
})

describe('agent-step failures and the live task context', () => {
  test('a failed agent step records its error and first stack lines, and the runner reports them', () => {
    const reported: string[] = []
    const trace = createTraceRecorder({ task: 7, agent: 'claude', loopId: 'l' }, (line) => reported.push(line))
    trace.onEvent({ type: 'node:start', nodeId: 'develop', runId: 'r' } as NodeLifecycle)
    const stack = ['Error: the agent exited 3', ...Array.from({ length: 12 }, (_, i) => `    at frame${i}`)].join('\n')
    trace.onEvent({ type: 'node:failed', nodeId: 'develop', runId: 'r', error: stack } as NodeLifecycle)
    const step = trace.finish('failed', {}).steps.find((s) => s.nodeId === 'develop')
    expect(step?.exitCode).toBe(1)
    expect(step?.error).toContain('the agent exited 3')
    expect(step?.error).not.toContain('frame11')
    expect(reported.join('\n')).toContain('the agent exited 3')
  })

  test('a throwing mechanical step reports only the message and the first stack lines', async () => {
    const reported: string[] = []
    const exits: Array<[string, number, string | undefined]> = []
    const error = new Error('the action broke')
    error.stack = ['Error: the action broke', ...Array.from({ length: 12 }, (_, i) => `    at frame${i}`)].join('\n')
    const actions = tracedActions(
      {
        'x.act': () => {
          throw error
        }
      },
      { recordExit: (nodeId, code, detail) => void exits.push([nodeId, code, detail]) },
      (line) => reported.push(line)
    )
    await expect(actions['x.act']?.({ nodeId: 'n', action: 'x.act', results: {} })).rejects.toBe(error)
    expect(exits[0]?.[2]).toContain('the action broke')
    expect(exits[0]?.[2]).not.toContain('frame11')
    expect(reported.join('\n')).not.toContain('frame11')
  })

  test('a tranche task and a backlog Issue resolve to their real branches', async () => {
    const lookups = {
      policy: () => ({ maxRounds: 4, maxTaskMinutes: 90 }) as never,
      fetchLabels: (n: number) => (n === 1564 ? ['vinaya/tranche:engine-harness-v1'] : []),
      fetchTitle: () => '[engine-harness-v1] 5 — The Engine runs one task'
    }
    const tranche = await liveTaskInput(
      { task: 1564, agent: 'claude', dryRun: false },
      '/repo',
      '/runtime',
      'l',
      lookups
    )
    expect(tranche.branch).toBe('task/engine-harness-v1/5')
    expect(tranche.worktreePath).toBe('/repo/.worktrees/task/engine-harness-v1/5')
    const backlog = await liveTaskInput({ task: 9, agent: 'claude', dryRun: false }, '/repo', '/runtime', 'l', lookups)
    expect(backlog.branch).toBe('task/issue-9')
  })

  test('staging the review input writes run files under the runtime directory, nothing under the repository', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-repo-')))
    const runtimeDir = realpathSync(mkdtempSync(join(tmpdir(), 'engine-runtime-')))
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-q')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    git('worktree', 'add', '-q', '-b', 'task/issue-9', join(root, '.worktrees', 'task', 'issue-9'))
    const before = readdirSync(root).sort()
    const input = await liveTaskInput({ task: 9, agent: 'claude', dryRun: false }, root, runtimeDir, 'l', {
      policy: () => ({ maxRounds: 4, maxTaskMinutes: 90 }) as never,
      fetchLabels: () => [],
      fetchTitle: () => 'a backlog Issue',
      reviewSources: { baseOf: () => 'base', brief: () => 'brief', prBody: () => '', diff: () => 'diff' }
    })
    const staged = input.stageReviewInput(1)
    expect(staged?.dir.startsWith(join(runtimeDir, 'tasks-execution', '9'))).toBe(true)
    // The held verdicts go to the task input's runtime directory, as do the Developer's sources.
    expect(input.runtimeDir).toBe(runtimeDir)
    const held: string[] = []
    const validate = createActions({
      ...input,
      buildVerdict: (role: string) => ({ observation: { role }, rendered: `held ${role}` }),
      reviewRound: () => 1,
      bound: { writeHeldVerdict }
    } as unknown as TaskInput)['vinaya.validate-reviewer-outputs'] as (context: never) => unknown
    const review = (role: string) => ({
      kind: 'agent-spawn',
      nodeId: role,
      exitCode: 0,
      events: [
        {
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
        }
      ]
    })
    validate({
      results: { 'code-review': review('code-reviewer'), 'security-review': review('security-reviewer') }
    } as never)
    for (const role of ['reviewer', 'security'] as const) held.push(heldVerdictPath(runtimeDir, 9, 1, role))
    for (const path of held) expect(readFileSync(path, 'utf8')).toContain('held')
    expect(developerSourceStoreDir(runtimeDir, 9).startsWith(join(runtimeDir, 'tasks-execution', '9'))).toBe(true)
    expect(readdirSync(root).sort()).toEqual(before)
    expect(before).toEqual(['.git', '.worktrees', 'a.txt'])
  })
})

// --- the Developer's live dev-tool context -----------------------------------

const HEADER = 'Fix(cli): Share live context'
const PR_BODY = '## Report\n\nbody'

const recordedLaunches: Array<{ task: number; agent: string; round: number | null }> = []

function liveContext(world: World, overrides: Partial<ReturnType<typeof fakeDeps>> = {}, task = 8) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'engine-live-context-'))
  const live = engineLiveDevToolsContext({
    branch: BRANCH,
    worktreePath: '/worktree',
    task,
    runtimeDir,
    agent: 'claude',
    repo: null,
    round: () => 1,
    deps: { ...fakeDeps(world), ...overrides },
    recordLaunch: (input) => {
      recordedLaunches.push(input)
      return `run-${recordedLaunches.length}`
    }
  })
  return { live, runtimeDir }
}

describe('the Engine builds its Developer context from the shared live context', () => {
  test('the runner builds that context through the shared module and keeps no push or pull-request open of its own', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'bin', 'run-engine.ts'), 'utf8')
    expect(source).toContain('createLiveDeveloperContext(')
    expect(source).not.toMatch(/['"]push['"]/)
    expect(source).not.toMatch(/['"]pr['"],\s*['"]create['"]/)
    expect(source).not.toContain('createEngineLiveDeveloperContext')
  })

  test('a publication runs the shared module: its commit, Broker push and pull-request open, never git or gh', async () => {
    const world = makeWorld()
    const { live } = liveContext(world)
    await live.beginTurn()
    // The turn's start recorded the head it publishes against and the branch base.
    expect(live.state.turnPreHead).toBe('head-0')
    expect(live.state.publicationExpectedBase).toBe(BASE)
    const published = await live.context.publishChanges(HEADER)
    expect(published).toMatchObject({ ok: true, result: { pushedHead: 'commit-1' } })
    expect(world.commits).toEqual([HEADER])
    expect(world.pushes.map((push) => push.sha)).toEqual(['commit-1'])
    expect(world.pushes[0]).toMatchObject({ task: 8, branch: BRANCH, agent: 'claude', round: 1 })
    const opened = await live.context.openPullRequest('[t] 8 — Title', PR_BODY)
    expect(opened).toEqual({ ok: true, result: { prNumber: 7 } })
    expect(world.opened).toHaveLength(1)
  })

  test('a head that moved during the turn is refused against the recorded pre-turn head', async () => {
    const world = makeWorld()
    const { live } = liveContext(world)
    await live.beginTurn()
    world.head = 'committed-by-the-developer'
    const result = await live.context.publishChanges(HEADER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.output).toContain('head moved')
    expect(world.commits).toEqual([])
    expect(world.pushes).toEqual([])
  })

  test('the next turn records its own starting head', async () => {
    const world = makeWorld()
    const { live } = liveContext(world)
    await live.beginTurn()
    await live.context.publishChanges(HEADER)
    world.head = 'after-review'
    await live.beginTurn()
    expect(live.state.turnPreHead).toBe('after-review')
  })

  test('the pushed range starts at the remote head, so a push authorizes exactly the commits after it', async () => {
    const world = makeWorld({ remote: 'remote-1', head: 'remote-1' })
    const { live } = liveContext(world)
    await live.beginTurn()
    await live.context.publishChanges(HEADER)
    expect(world.rangeBases.length).toBeGreaterThan(0)
    expect(world.rangeBases.every((base) => base === 'remote-1')).toBe(true)
    expect(world.pushes[0]?.touchedPaths).toEqual([OWN])
  })

  test('a path beyond the Surface is recorded in the opened pull request body', async () => {
    const world = makeWorld({ changed: [OWN, OUTSIDE] })
    const { live } = liveContext(world)
    await live.beginTurn()
    await live.context.publishChanges(HEADER)
    await live.context.openPullRequest('[t] 8 — Title', PR_BODY)
    expect(world.opened[0]?.body).toContain('AEG:BEYOND-SURFACE')
    expect(world.opened[0]?.body).toContain(OUTSIDE)
  })

  test('records are written under write attribution: the driver tool call is not reported, a worker write is', async () => {
    const world = makeWorld()
    const { live, runtimeDir } = liveContext(world)
    const control = taskControlDir(runtimeDir, 8)
    mkdirSync(control, { recursive: true })
    world.push = (input) => {
      // The Broker records the effect while the driver's own tool call runs.
      writeFileSync(join(control, 'effect.json'), input.sha)
      return { ok: true }
    }
    await live.beginTurn()
    await live.context.publishChanges(HEADER)
    expect(live.changedProtectedPaths()).toEqual([])
    writeFileSync(join(control, 'worker.json'), 'written between tool calls')
    expect(live.changedProtectedPaths()).toContain(control)
  })

  test('a protected path the Surface does not name is refused by the Broker, leaving the work committed', async () => {
    const world = makeWorld({ changed: [OWN, WORKFLOW] })
    const { live, runtimeDir } = liveContext(world)
    world.push = brokerPush(() => runtimeDir)
    await live.beginTurn()
    const result = await live.context.publishChanges(HEADER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.output).toContain('protected administrative policy path')
    expect(world.commits).toEqual([HEADER])
    expect(world.remote).toBe('head-0')
  })

  test('a refused push leaves the work committed and unpushed, and the next Developer prompt quotes the refusal', async () => {
    const world = makeWorld()
    world.pushResults.push({ ok: false, refusal: '(fail) tests/a.test.ts > breaks', hook: true })
    const { live } = liveContext(world)
    await live.beginTurn()
    const refused = await live.context.publishChanges(HEADER)
    expect(refused.ok).toBe(false)
    expect(world.commits).toEqual([HEADER])
    expect(world.remote).toBe('head-0')
    expect(live.state.lastPushRefusal).toBe('(fail) tests/a.test.ts > breaks')
    const prompt = developerPrompt('x', { ...FACTS, lastPushRefusal: live.state.lastPushRefusal }, {})
    expect(prompt).toContain('Your last `publish_changes` for this branch was refused by the pre-push hook')
    expect(prompt).toContain('(fail) tests/a.test.ts > breaks')
    expect(developerPrompt('x', FACTS, {})).not.toContain('refused by the pre-push hook')
    // The retry pushes the committed work without a second commit.
    const retried = await live.context.publishChanges(HEADER)
    expect(retried.ok).toBe(true)
    expect(world.commits).toEqual([HEADER])
    expect(live.state.lastPushRefusal).toBeNull()
  })

  test('a clean worktree with an open pull request publishes nothing', async () => {
    const world = makeWorld({ dirty: [], pr: { number: 7 }, prBody: PR_BODY })
    const { live } = liveContext(world)
    await live.beginTurn()
    expect(await live.context.publishChanges(HEADER)).toMatchObject({ ok: true, result: { pushedHead: 'head-0' } })
    expect(world.commits).toEqual([])
    expect(world.pushes).toEqual([])
    expect(world.opened).toEqual([])
  })

  test('a restart with the pull request open attaches without a second commit, push or open', async () => {
    const world = makeWorld({ dirty: [], pr: { number: 7 }, prBody: PR_BODY })
    // A new process: a new context with no state from the earlier run.
    const { live } = liveContext(world)
    await live.beginTurn()
    expect((await live.context.publishChanges(HEADER)).ok).toBe(true)
    const again = await live.context.openPullRequest('[t] 8 — Title', PR_BODY)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.check).toBe('pr-exists')
    expect(world.commits).toEqual([])
    expect(world.pushes).toEqual([])
    expect(world.opened).toEqual([])
  })

  test('read_pull_request returns the log tail of a failed check', async () => {
    const world = makeWorld({ pr: { number: 7 } })
    world.view = {
      prNumber: 7,
      state: 'OPEN',
      head: 'head-0',
      checks: [],
      reviews: [],
      body: PR_BODY,
      failedChecks: failedCheckLogsOnHead(
        'head-0',
        () => [{ name: 'unit', id: 41 }],
        () => 'expected 1, received 2'
      )
    }
    const { live } = liveContext(world)
    const view = await live.context.readPullRequest()
    expect(view.ok).toBe(true)
    if (view.ok)
      expect(view.result.failedChecks).toEqual([{ check: 'unit', runId: 41, logTail: 'expected 1, received 2' }])
  })

  describe('fetch_documentation', () => {
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

    test('issues a source receipt for real content, in the task source store', async () => {
      const world = makeWorld()
      const { live, runtimeDir } = liveContext(world, {
        fetchDocumentationDeps: page(`# Hooks\n\n${'Documentation. '.repeat(100)}`)
      })
      const result = await live.context.fetchDocumentation({ url: 'https://docs.example.com/hooks' })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.result.receipt).toMatchObject({ recorded: true })
      const receipts = readFileSync(sourceReceiptsPath(developerSourceStoreDir(runtimeDir, 8)), 'utf8')
      expect(receipts).toContain('https://docs.example.com/hooks')
    })

    test('issues none for a near-empty page', async () => {
      const world = makeWorld()
      const { live, runtimeDir } = liveContext(world, { fetchDocumentationDeps: page('tiny') })
      const result = await live.context.fetchDocumentation({ url: 'https://docs.example.com/hooks' })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.result.receipt).toMatchObject({ recorded: false })
      expect(existsSync(sourceReceiptsPath(developerSourceStoreDir(runtimeDir, 8)))).toBe(false)
    })
  })
})

// --- the reviewers reach their tool host -------------------------------------

const SPEC = 'specs/isolation.md'

describe('the tool host serves the reviewer roles as well as the Developer', () => {
  test('starts a host per role, and each reviewer reads a pinned source through read_source', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'engine-read-source-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    git('config', 'commit.gpgsign', 'false')
    mkdirSync(join(repo, 'specs'))
    writeFileSync(join(repo, SPEC), '# Isolation\n\nThe writable roots.\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const { options, runtimeDir } = stubRun()
    await prepareSources({
      brief: `## Objectives\n\nO1. Something.\n\n## Documentation\n\n- ${SPEC} — the mechanism it governs (O1)\n\n## Premises\n`,
      round: 1,
      base: git('rev-parse', 'HEAD'),
      storeDir: developerSourceStoreDir(runtimeDir, 7),
      deps: {
        readObject: gitObjectReader(repo),
        fetch: {
          resolve: async () => [],
          request: async () => {
            throw new Error('no network')
          },
          now: () => new Date()
        },
        now: () => new Date()
      }
    })
    const served: Record<string, NonNullable<Parameters<EngineRunOptions['startHost']>[0]['context']>> = {}
    await runEngine({
      ...options,
      taskInput: { ...options.taskInput, worktreePath: repo } as unknown as TaskInput,
      startHost: async (host) => {
        served[host.role] = host.context
        return { close: async () => {} }
      }
    })
    expect(Object.keys(served).sort()).toEqual(['code-reviewer', 'developer', 'security'])
    for (const role of ['code-reviewer', 'security']) {
      const read = await served[role]?.readSource?.({ sourceId: SPEC })
      expect(read?.ok).toBe(true)
      if (read?.ok) expect(read.result.content).toContain('The writable roots.')
    }
  })

  for (const [vendor, file] of [
    ['claude-code', 'role-mcp.json'],
    ['codex', 'config.toml']
  ] as const) {
    test(`each reviewer ${vendor} launch runs in that attempt's scratch directory`, () => {
      const generatedRoot = mkdtempSync(join(tmpdir(), 'engine-reviewer-cwd-'))
      const roles = createRoleLaunchers({ vendor, generatedRoot })
      const seen: Array<{ cwd?: string; args: string[] }> = []
      const wrapped = withReviewerWorkingDirectory(
        (_command, args, options) => {
          seen.push({ ...(options?.cwd ? { cwd: options.cwd } : {}), args: [...args] })
          return stubAgent('reviewer', [])
        },
        generatedRoot,
        (role) => `/scratch/${role}/attempt-2`
      )
      for (const role of ['code-reviewer', 'security-reviewer'] as const) {
        const launcher = roles[role]
        if (!launcher) throw new Error(`missing ${role} launcher`)
        wrapped(launcher.command, launcher.buildArgs({ permission: `${role}/grants.yaml`, maxTurns: 100 }), {
          env: launcher.env ?? {},
          cwd: '/repo'
        })
      }
      expect(seen.map(({ cwd }) => cwd)).toEqual(['/scratch/reviewer/attempt-2', '/scratch/security/attempt-2'])
    })

    test(`each reviewer's ${vendor} launch names its own host`, () => {
      const generatedRoot = mkdtempSync(join(tmpdir(), 'engine-launch-shapes-'))
      createRoleLaunchers({
        vendor,
        generatedRoot,
        mcpCommands: {
          developer: '/shims/developer.sh',
          'code-reviewer': '/shims/code-reviewer.sh',
          'security-reviewer': '/shims/security-reviewer.sh'
        }
      })
      for (const role of ['developer', 'code-reviewer', 'security-reviewer']) {
        const config = readFileSync(join(generatedRoot, role, file), 'utf8')
        expect(config).toContain(`/shims/${role}.sh`)
        for (const other of ['developer', 'code-reviewer', 'security-reviewer'].filter((name) => name !== role))
          expect(config).not.toContain(`/shims/${other}.sh`)
      }
    })
  }
})

describe('the repository a run works in', () => {
  test('is the git top level of the starting directory, not the folder the runner ships in', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engine-target-repo-')))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    mkdirSync(join(dir, 'nested'))
    expect(targetRepoRoot(join(dir, 'nested'))).toBe(dir)
    expect(targetRepoRoot(join(dir, 'nested'))).not.toBe(resolve(import.meta.dir, '../../..'))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('a Developer turn on the Engine path', () => {
  test('records the launch the Broker authenticates its pushes against', async () => {
    const before = recordedLaunches.length
    const { live } = liveContext(makeWorld(), {}, 31)
    await live.beginTurn()
    expect(recordedLaunches.length).toBe(before + 1)
    expect(recordedLaunches.at(-1)).toMatchObject({ task: 31, agent: 'claude', round: 1 })
  })
})
