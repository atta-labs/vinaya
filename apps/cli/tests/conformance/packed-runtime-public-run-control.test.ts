import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileFlow, type Plan, type StepsFlow } from '@atta/engine'
import {
  type AgentLifecycleEvent,
  type AgentLifecycleNodeExecutor,
  type AgentSpawnExecutorConfig,
  createRunControl,
  type RunControl,
  RunHaltedError,
  type RunIdentity,
  type RunOutcome,
  readRunCheckpoint,
  resumeControlledRun,
  type SpawnedProcessLike,
  type SpawnFn,
  startControlledRun
} from '@atta/executor-agent-spawn'
import { MemorySaver } from '@langchain/langgraph'

// The packed runtime's public run control, driven with a caller-supplied node
// executor: start, halt, checkpoint read, resume and cancel go through the
// public exports of the installed tarballs only, and the same Flow under the
// built-in executor yields the same lifecycle events and checkpoint
// transitions. Nothing spawns a real agent: the caller's executor is a stub
// that records node ids, and the built-in one runs against a fake spawn.

const STEPS = ['prepare', 'develop', 'finish'] as const

function sampleFlow(root: string): StepsFlow {
  return {
    schemaVersion: '2.0',
    id: 'vinaya-public-run-control',
    displayName: 'Vinaya public run control',
    description: 'Exercises the packed public start, halt, resume and cancel.',
    experimental: true,
    benchmarked: false,
    defaults: { model: 'consumer-supplied' },
    agents: [{ role: 'developer' }],
    steps: [
      { id: 'prepare', type: 'mechanical', action: 'sample.prepare' },
      {
        id: 'develop',
        type: 'agent',
        role: 'developer',
        promptTemplate: 'Implement {{question}}.',
        permission: 'workspace-write',
        workingDirectory: root,
        maxTurns: 1
      },
      { id: 'finish', type: 'mechanical', action: 'sample.finish' }
    ]
  } as StepsFlow
}

interface Fixture {
  plan: Plan
  root: string
  baseConfig: AgentSpawnExecutorConfig
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'packed-run-control-')))
  const plan = compileFlow(sampleFlow(root), 'the prepared task')
  const baseConfig: AgentSpawnExecutorConfig = {
    roleBinaries: {
      developer: { command: 'developer-agent', buildArgs: () => [], allowedPermissions: ['workspace-write'] }
    },
    workingDirectoryRoot: root,
    mechanicalActions: {
      'sample.prepare': { command: 'prepare-command' },
      'sample.finish': { command: 'finish-command' }
    }
  }
  return { plan, root, baseConfig }
}

/** A spawned process that exits 0 with no output once its input closes. */
function fakeProcess(): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  const close = (code: number | null) => {
    for (const listener of closeListeners) listener(code)
  }
  return {
    stdin: { write: () => {}, end: () => setTimeout(() => close(0), 0) },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => close(null)
  }
}

/** The caller-supplied executor: records each node id it runs and returns a result of that node's kind. */
function recordingExecutor(
  executed: string[],
  before: (nodeId: string, signal: AbortSignal | undefined) => Promise<void> | void = () => {}
): AgentLifecycleNodeExecutor {
  return async (_state, { node, signal }) => {
    await before(node.id, signal)
    executed.push(node.id)
    if (node.kind === 'mechanical') {
      return {
        results: {
          [node.id]: {
            nodeId: node.id,
            kind: 'mechanical',
            action: node.action,
            command: `caller:${node.action}`,
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 0
          }
        }
      }
    }
    return { results: { [node.id]: { nodeId: node.id, kind: 'agent-spawn', events: [], exitCode: 0, durationMs: 0 } } }
  }
}

interface Transition {
  reason: RunOutcome['reason']
  completed: string[]
  pending: string[] | undefined
}

interface StepwiseRun {
  events: string[]
  transitions: Transition[]
  executed: string[]
}

/**
 * Runs the Flow one step per leg: every completed node halts the leg through public run control, the checkpoint is
 * read back through the public reader, and the next leg continues through the public resume. One fresh checkpointer
 * per run.
 */
async function runStepwise(useCallerExecutor: boolean): Promise<StepwiseRun> {
  const { plan, baseConfig } = fixture()
  const checkpointer = new MemorySaver()
  const events: string[] = []
  const transitions: Transition[] = []
  const executed: string[] = []
  const spawnFn: SpawnFn = (command) => {
    executed.push(command)
    return fakeProcess()
  }
  const executor = useCallerExecutor ? recordingExecutor(executed) : undefined
  let identity: RunIdentity | undefined
  for (let leg = 0; leg <= STEPS.length; leg++) {
    const control: RunControl = createRunControl()
    const config: AgentSpawnExecutorConfig = {
      ...baseConfig,
      onEvent: (event: AgentLifecycleEvent) => {
        events.push(`${event.type}:${event.nodeId}`)
        if (event.type === 'node:complete') control.halt('step boundary')
      }
    }
    const params = { plan, config, checkpointer, control, spawnFn, ...(executor ? { executor } : {}) }
    const outcome: RunOutcome =
      identity === undefined ? await startControlledRun(params) : await resumeControlledRun({ ...params, identity })
    identity = outcome.identity
    const checkpoint = await readRunCheckpoint(checkpointer, identity)
    transitions.push({
      reason: outcome.reason,
      completed: Object.keys(checkpoint?.results ?? {}).sort(),
      pending: outcome.reason === 'paused' ? outcome.pendingNodes : undefined
    })
    if (outcome.reason !== 'paused') break
  }
  return { events, transitions, executed }
}

describe('the packed Atta runtime public run control with a caller-supplied executor', () => {
  it('cutover-gate:gate-16 — public start runs the caller executor, halts, reads its checkpoint, and public resume continues without re-running a finished step', async () => {
    const { plan, baseConfig } = fixture()
    const checkpointer = new MemorySaver()
    const executed: string[] = []
    const control = createRunControl()
    const executor = recordingExecutor(executed, (nodeId) => {
      if (nodeId === 'prepare') control.halt('inspect')
    })

    const paused = await startControlledRun({ plan, config: baseConfig, checkpointer, control, executor })
    expect(paused.reason).toBe('paused')
    if (paused.reason !== 'paused') throw new Error('the run did not pause')
    expect(paused.haltReason).toBe('inspect')
    expect(executed).toEqual(['prepare'])

    const checkpoint = await readRunCheckpoint(checkpointer, paused.identity)
    expect(checkpoint?.identity).toEqual(paused.identity)
    expect(Object.keys(checkpoint?.results ?? {})).toEqual(['prepare'])
    // The caller's executor wrote this result; the built-in one would name its configured command.
    expect(checkpoint?.results.prepare).toMatchObject({ kind: 'mechanical', command: 'caller:sample.prepare' })
    expect(paused.pendingNodes).toEqual(['develop'])

    const resumed = await resumeControlledRun({
      plan,
      config: baseConfig,
      checkpointer,
      executor,
      identity: paused.identity
    })
    expect(resumed.reason).toBe('completed')
    if (resumed.reason !== 'completed') throw new Error('the run did not complete')
    expect(resumed.identity).toEqual(paused.identity)
    expect(executed).toEqual([...STEPS])
    expect(Object.keys(resumed.checkpoint.results).sort()).toEqual([...STEPS].sort())
    expect(resumed.checkpoint.results.finish).toMatchObject({ command: 'caller:sample.finish' })
  })

  it('public run control cancels a second run while the caller executor is working, and no later step runs', async () => {
    const { plan, baseConfig } = fixture()
    const checkpointer = new MemorySaver()
    const executed: string[] = []
    const control = createRunControl()
    let started: () => void = () => {}
    const developing = new Promise<void>((resolve) => {
      started = resolve
    })
    const executor = recordingExecutor(executed, async (nodeId, signal) => {
      if (nodeId !== 'develop') return
      started()
      // Work under way stops when the run is cancelled; the executor reports it as a halt.
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new RunHaltedError(nodeId, control.haltReason)))
      })
    })

    const running = startControlledRun({ plan, config: baseConfig, checkpointer, control, executor })
    await developing
    control.halt('cancel')
    const cancelled = await running

    expect(cancelled.reason).toBe('paused')
    if (cancelled.reason !== 'paused') throw new Error('the run was not stopped')
    expect(cancelled.haltReason).toBe('cancel')
    expect(executed).toEqual(['prepare'])
    const checkpoint = await readRunCheckpoint(checkpointer, cancelled.identity)
    expect(Object.keys(checkpoint?.results ?? {})).toEqual(['prepare'])
  })

  it('the caller executor and the built-in executor produce the same lifecycle events and checkpoint transitions', async () => {
    const caller = await runStepwise(true)
    const builtIn = await runStepwise(false)

    expect(caller.executed).toEqual([...STEPS])
    expect(builtIn.executed).toEqual(['prepare-command', 'developer-agent', 'finish-command'])
    expect(caller.events).toEqual(STEPS.flatMap((step) => [`node:start:${step}`, `node:complete:${step}`]))
    expect(caller.events).toEqual(builtIn.events)
    expect(caller.transitions).toEqual(builtIn.transitions)
    expect(caller.transitions.map((transition) => transition.reason)).toEqual(['paused', 'paused', 'completed'])
  })

  it('imports the packed runtime only through its public package exports', () => {
    const source = readFileSync(import.meta.path, 'utf8')
    const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1] as string)
    const runtime = specifiers.filter((specifier) => /^@(?:atta|langchain)\//.test(specifier))
    expect(runtime.length).toBeGreaterThan(0)
    // No dynamic import or require reaches the runtime around the static imports checked here.
    expect(source).not.toMatch(/(?:import|require)\s*\(\s*['"`]@(?:atta|langchain)\//)
    for (const specifier of runtime) {
      // A bare package name only: no subpath, so no `dist/` or other internal path.
      expect(specifier).toMatch(/^@[a-z0-9-]+\/[a-z0-9-]+$/)
      const entry = Bun.resolveSync(specifier, import.meta.dir)
      const packageRoot = entry.slice(0, entry.lastIndexOf(`/node_modules/${specifier}/`) + 1)
      // The installed copy, never workspace source, answers each runtime import.
      expect(packageRoot).not.toBe('')
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, 'node_modules', specifier, 'package.json'), 'utf8')
      ) as { name: string; exports?: Record<string, unknown> }
      expect(manifest.name).toBe(specifier)
      if (manifest.exports) expect(Object.keys(manifest.exports)).toContain('.')
    }
    // The graph is driven only through public run control: no graph builder or raw invocation is imported.
    const executorImport = source.match(/import\s*\{([^}]*)\}\s*from\s*'@atta\/executor-agent-spawn'/)?.[1] ?? ''
    const names = executorImport
      .split(',')
      .map((name) => name.replace(/^\s*type\s+/, '').trim())
      .filter(Boolean)
      .sort()
    const runControl = [
      'AgentLifecycleEvent',
      'AgentLifecycleNodeExecutor',
      'AgentSpawnExecutorConfig',
      'createRunControl',
      'RunControl',
      'RunHaltedError',
      'RunIdentity',
      'RunOutcome',
      'readRunCheckpoint',
      'resumeControlledRun',
      'SpawnedProcessLike',
      'SpawnFn',
      'startControlledRun'
    ].sort()
    expect(names).toEqual(runControl)
  })
})
