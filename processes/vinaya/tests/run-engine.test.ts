import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import type { ActionRegistry } from '../../../harness/dev-process/engine-runtime/run-process'
import type { NodeLifecycle } from '../../../harness/dev-process/logging/translate'
import { devToolsSocketPath } from '../../../apps/cli/src/lib/task-tools/dev-tools-registration'
import { classifyGateResult, createActions, dispatchReviewers, type TaskInput } from '../executing/actions'
import { heldVerdictPath, writeHeldVerdict } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import type { DeveloperPromptFacts } from '../executing/developer-prompt'
import {
  checkpointPath,
  createTraceRecorder,
  tracedActions,
  developerSourceStoreDir,
  dryRunLines,
  liveTaskInput,
  parseArgs,
  runEngine,
  shimContent,
  type EngineRunOptions,
  type RunTrace
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
      expect(lines.filter((line) => line.startsWith('step '))).toHaveLength(14)
      const bound = lines.filter((line) => line.startsWith('bound '))
      expect(bound).toHaveLength(11)
      expect(bound).toContain('bound publish-ready-for-merge harness.publish: publishRound')
      expect(bound).toContain(
        'bound validate-reviewer-outputs vinaya.validate-reviewer-outputs: parseReviewResult, writeHeldVerdict'
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
      'vinaya.validate-developer-output',
      'harness.run-gates',
      'vinaya.classify-gate-result',
      'vinaya.dispatch-reviewers',
      'vinaya.validate-reviewer-outputs',
      'vinaya.assess-round',
      'vinaya.build-revision-handoff',
      'harness.publish'
    ].map((name) => [
      name,
      async (context) => {
        if (scenario.haltAt === context.nodeId) control.halt('stop here')
        if (scenario.failAt === context.nodeId) throw new Error('the action broke')
        if (name === 'vinaya.classify-gate-result') return classifyGateResult(context)
        if (name === 'vinaya.dispatch-reviewers') return dispatchReviewers()
        return { exitCode: 0 }
      }
    ])
  )
  const options: EngineRunOptions = {
    args: { task: 7, agent: 'claude', dryRun: false },
    process: loaded,
    repoRoot,
    runtimeDir,
    loopId: 'loop-under-test',
    taskInput: {} as TaskInput,
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
      expect(host.socketPath).toBe(devToolsSocketPath('engine-7'))
      expect(host.role).toBe('developer')
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
  return { options, emitted, calls, observed, runtimeDir }
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
      'develop',
      'validate-developer-output',
      'run-mechanical-gates',
      'classify-gate-result',
      'dispatch-reviewers',
      'code-review',
      'security-review',
      'validate-reviewer-outputs',
      'assess-round',
      'build-revision-handoff',
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
    const heartbeat = 'dev_review_loop.driver_heartbeat'
    const attempt = 'role_attempt.attempted'
    expect(kinds).toEqual([
      ...[heartbeat, heartbeat, heartbeat, heartbeat, attempt],
      ...[heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, attempt, attempt],
      ...[heartbeat, heartbeat, heartbeat, heartbeat, 'dev_review_loop.driver_exited']
    ])
  })

  test('starts the host before the Developer and writes the executable shim', async () => {
    const { options, calls } = stubRun()
    const result = await runEngine(options)
    expect(calls.indexOf('host-start')).toBeLessThan(calls.indexOf('spawn:develop'))
    const shim = join(options.runtimeDir, 'engine-runs', '7', 'dev-bridge.sh')
    expect(readFileSync(shim, 'utf8')).toBe(
      shimContent(devToolsSocketPath('engine-7'), process.execPath, join(repoRoot, 'apps/cli/src/index.ts'))
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
    expect(calls.filter((call) => call === 'host-close')).toHaveLength(1)
    expect(calls.indexOf('host-close')).toBeLessThan(calls.indexOf('drain'))
  })

  test('closes the host and drains the sink when a step fails', async () => {
    const { options, calls } = stubRun({ failAt: 'run-mechanical-gates' })
    const result = await runEngine(options)
    expect(result.exitCode).toBe(1)
    expect(calls.filter((call) => call === 'host-close')).toHaveLength(1)
    expect(calls.filter((call) => call === 'drain')).toHaveLength(1)
    expect(readTrace(result.tracePath).outcome).not.toBe('completed')
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
    expect(calls.filter((call) => call === 'host-close')).toHaveLength(1)
    expect(calls.filter((call) => call === 'drain')).toHaveLength(1)
  })

  test('drains the sink when the host cannot start, and launches no agent', async () => {
    const { options, calls } = stubRun({ hostFails: true })
    const result = await runEngine(options)
    expect(result.exitCode).toBe(1)
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
      renderVerdict: (role: string) => `held ${role}`,
      reviewRound: () => 1,
      bound: { writeHeldVerdict }
    } as TaskInput)['vinaya.validate-reviewer-outputs'] as (context: never) => unknown
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
