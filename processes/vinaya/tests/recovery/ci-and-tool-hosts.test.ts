import { afterAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initialLoopState } from '@attalabs/aeg-core'
import type { SpawnedProcessLike, StepNodeResult } from '@atta/executor-agent-spawn'
import type { ActionContext, ActionRegistry } from '../../../../harness/dev-process/engine-runtime/run-process'
import type { AgentCheckpointProvenance } from '../../../../harness/dev-process/engine-runtime/checkpoint-round'
import { loadProcess } from '../../../../harness/dev-process/loader/load-process'
import {
  createDispatchCapabilityTable,
  startDevToolsHost,
  startReplaceableDevToolsHost
} from '../../../../apps/cli/src/lib/task-tools/dev-tools-host'
import { READ_SOURCE_NOTICE } from '../../../../apps/cli/src/lib/task-tools/read-source'
import {
  DISPATCH_CAPABILITY_ARGUMENT,
  type DevToolContext
} from '../../../../apps/cli/src/lib/task-tools/dev-tools-server'
import {
  ACTION_BINDINGS,
  classifyGateResult,
  createActions,
  decisions,
  dispatchReviewers,
  type TaskInput
} from '../../executing/actions'
import { createV2Actions, V2_DECISIONS } from '../../loops/dev-review/v2/v2-actions'
import {
  crossAgentResumeRefusal,
  MAX_TOOL_HOST_LOSSES,
  runEngine,
  withDispatchCapabilities,
  withToolHostBoundaries,
  type Agent,
  type EngineRunOptions,
  type RoleDispatches
} from '../../bin/run-engine'
import { recordedHandoff } from '../handoff-fakes'
import { ENGINE_RUNNERS } from './runners'

// Owner: agent B. An unpushed head never reaches a CI read; dev-tools hosts are replaced only at a dispatch boundary;
// a checkpoint resumes only on the agent it started with.

const scratch: string[] = []
const scratchDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const LOCAL = 'a'.repeat(40)
const REMOTE = 'b'.repeat(40)

const mechanical = (nodeId: string, exitCode: number, stdout = ''): StepNodeResult =>
  ({ nodeId, kind: 'mechanical', action: nodeId, command: '', exitCode, stdout, stderr: '', durationMs: 0 }) as never

/** A task whose worktree head and remote head are given, with a forge that counts every CI read. */
function ciTask(heads: { local: string; remote: () => string | null }, ci: () => 'green' | 'red' | 'pending') {
  const reads: string[] = []
  const task = {
    runtimeDir: scratchDir('ci-runtime-'),
    cliEntry: '',
    branch: 'task/issue-9',
    issueNumber: 9,
    worktreePath: scratchDir('ci-worktree-'),
    developerContext: { knownFindingIds: [], requiredSources: [] },
    loopState: initialLoopState({
      loopId: 'recovery-ci',
      task: 9,
      reviewers: ['reviewer', 'security'],
      models: {},
      maxRounds: 5,
      maxTaskMinutes: 0
    }),
    reviewRound: () => 1,
    remoteHead: heads.remote,
    gatePoll: { gatePollMaxAttempts: 3, gatePollIntervalMs: 0, sleep: async () => {} },
    bound: {
      readWorktreeHead: () => heads.local,
      fetchCiConclusion: (head: string) => {
        reads.push(head)
        return ci()
      },
      fetchFailingCheckRuns: () => [],
      fetchFailedCheckWorkflowRunIds: () => [],
      discardHeldVerdicts: () => {}
    },
    v2: {
      findOpenPullRequest: () => ({ number: 70 }),
      stagedPullRequest: () => null,
      openPullRequest: () => ({ ok: true, pr: 70 }),
      endStoragePushes: () => {}
    }
  } as unknown as TaskInput
  return { task, reads }
}

const context = (nodeId: string, results: Record<string, StepNodeResult>): ActionContext => ({
  nodeId,
  action: nodeId,
  results
})

const recordOf = (stdout: string | undefined) => JSON.parse(stdout ?? '{}') as Record<string, unknown>

/** The v1 gate: the CI read, then the assessment it feeds; returns what the start of the next step would be. */
async function v1Gate(task: TaskInput) {
  const actions = createActions(task)
  const results: Record<string, StepNodeResult> = { 'run-mechanical-gates': mechanical('run-mechanical-gates', 0) }
  const ci = await actions['vinaya.read-forge-ci']!(context('read-forge-ci', results))
  results['read-forge-ci'] = mechanical('read-forge-ci', ci.exitCode, ci.stdout)
  const assessed = await actions['vinaya.assess-gate']!(context('assess-gate', results))
  results['assess-gate'] = mechanical('assess-gate', assessed.exitCode, assessed.stdout)
  const next = decisions['classify-gate-result']!(results['assess-gate']) ? 'develop' : 'run-security-scan'
  return { ci: recordOf(ci.stdout), sendBack: recordOf(assessed.stdout).sendBack, next }
}

/** The v2 CI step after an approval; returns its record and where the flow's decision sends the run. */
async function v2Ci(task: TaskInput) {
  const actions = createV2Actions(task)
  const read = await actions['vinaya.v2-read-ci-once']!(context('read-ci-once', {}))
  const result = mechanical('read-ci-once', read.exitCode, read.stdout)
  const record = recordOf(read.stdout)
  return {
    ci: record,
    sendBack: record.sendBack,
    next: V2_DECISIONS['classify-ci-result'](result) ? 'develop' : 'check-publish-mergeability'
  }
}

describe.each(ENGINE_RUNNERS)('%s', (runner) => {
  const flow = runner === 'engine-v1' ? v1Gate : v2Ci

  test('an unpushed head with a pull request open goes to the Developer with no CI poll', async () => {
    const { task, reads } = ciTask({ local: LOCAL, remote: () => REMOTE }, () => 'pending')
    const ran = await flow(task)
    expect(reads).toEqual([])
    expect(ran.next).toBe('develop')
    expect(ran.sendBack).toMatchObject({ kind: 'unpushed', headBefore: REMOTE })
  })

  test('a pushed head is read as before', async () => {
    const { task, reads } = ciTask({ local: LOCAL, remote: () => LOCAL }, () => 'green')
    const ran = await flow(task)
    expect(reads).toEqual([LOCAL])
    expect(ran.next).not.toBe('develop')
  })

  test('a remote-read failure stays a read failure', async () => {
    // The remote head cannot be read: nothing is claimed unpushed, and the head is read as today.
    const unreadable = ciTask(
      {
        local: LOCAL,
        remote: () => {
          throw new Error('the forge is unreachable')
        }
      },
      () => 'green'
    )
    const ran = await flow(unreadable.task)
    expect(unreadable.reads).toEqual([LOCAL])
    expect(ran.ci.conclusion).toBe('green')
    expect(ran.next).not.toBe('develop')
    // A CI read that never resolves keeps its own handling: red once the poll budget is spent, never `unpushed`.
    const failing = ciTask({ local: LOCAL, remote: () => LOCAL }, () => {
      throw new Error('the checks API failed')
    })
    const red = await flow(failing.task)
    expect(failing.reads).toHaveLength(1)
    expect(red.ci.conclusion).toBe('red')
    expect(red.next).toBe('develop')
  })
})

// --- the agent a checkpoint resumes on -----------------------------------------------

const loaded = loadProcess(resolve(import.meta.dir, '../..'))
const repoRoot = resolve(import.meta.dir, '../../../..')
const stubHome = scratchDir('recovery-codex-home-')
writeFileSync(join(stubHome, 'auth.json'), '{}\n')
process.env.CODEX_HOME = stubHome

function stubAgent(lines: string[]): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  return {
    pid: process.pid,
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

/** An Engine run of stub actions and agents; the gate step throws on its first run, so the run pauses after `develop`. */
function stubRun(agent: Agent, runtimeDir: string, provenance?: () => AgentCheckpointProvenance | null) {
  const spawns: string[] = []
  const actionRuns: string[] = []
  let gateBroke = false
  const actions: ActionRegistry = Object.fromEntries(
    Object.keys(ACTION_BINDINGS).map((name) => [
      name,
      async (ctx: ActionContext) => {
        actionRuns.push(ctx.nodeId)
        if (name === 'harness.run-gates' && !gateBroke) {
          gateBroke = true
          throw new Error('the gate runner broke')
        }
        if (name === 'vinaya.classify-gate-result') return classifyGateResult(ctx)
        if (name === 'vinaya.dispatch-reviewers') return dispatchReviewers()
        return { exitCode: 0 }
      }
    ])
  )
  const handoff = recordedHandoff()
  const options: EngineRunOptions = {
    args: { task: 7, agent, dryRun: false },
    process: loaded,
    repoRoot,
    runtimeDir,
    loopId: 'recovery-resume',
    taskInput: { branch: 'task/issue-7' } as TaskInput,
    heldPullRequestConflicts: async () => false,
    handoffDeps: { ...handoff.deps, sleepSync: () => {} },
    actions,
    sink: { log: () => {}, drain: async () => {} },
    startHost: async () => ({ close: async () => {} }),
    devToolsContext: {} as never,
    out: () => {},
    revision: 'rev-a',
    // The first run's driver lock names this live process; the later run takes it over as a restarted driver would.
    lifecycle: { killGraceMs: 200, handleSignals: false, isPidAlive: () => false },
    spawnFn: (_command, _args) => {
      spawns.push('agent')
      return stubAgent(['{"type":"result"}'])
    },
    ...(provenance ? { readAgentProvenance: provenance } : {})
  }
  return { options, spawns, actionRuns, handoff }
}

const provenanceFor = (agent: AgentCheckpointProvenance['agent']): AgentCheckpointProvenance =>
  ({ agent }) as AgentCheckpointProvenance

describe('engine resume', () => {
  test('the refusal names the agent rule, and a legacy checkpoint the fresh start', () => {
    const crossed = crossAgentResumeRefusal(provenanceFor('codex'), 7, 'claude', '/run/checkpoints.sqlite')
    expect(crossed).toContain('the Engine continues a run on the agent it started with')
    expect(crossed).toContain('codex')
    const legacy = crossAgentResumeRefusal(provenanceFor(null), 7, 'claude', '/run/checkpoints.sqlite')
    expect(legacy).toContain('the Engine continues a run on the agent it started with')
    expect(legacy).toContain('start the task fresh')
    expect(crossAgentResumeRefusal(null, 7, 'codex', '/run/checkpoints.sqlite')).toContain('start the task fresh')
    expect(crossAgentResumeRefusal(provenanceFor('codex'), 7, 'codex', '/run/checkpoints.sqlite')).toBeNull()
  })

  for (const [name, recorded] of [
    ['a Codex checkpoint resumed with Claude is refused and changes nothing', 'codex'],
    ['a legacy checkpoint is refused with the fresh-start instruction and changes nothing', null]
  ] as const) {
    test(name, async () => {
      const runtimeDir = scratchDir('recovery-resume-')
      const first = stubRun('codex', runtimeDir, () => provenanceFor('codex'))
      await runEngine(first.options)
      expect(first.spawns).toHaveLength(1)
      const checkpoint = join(runtimeDir, 'engine-runs', '7', 'checkpoints.sqlite')
      const before = readFileSync(checkpoint)
      const pausesBefore = first.handoff.calls.length
      const asked: string[] = []
      const second = stubRun('claude', runtimeDir, () => {
        asked.push('read')
        return provenanceFor(recorded)
      })
      const result = await runEngine(second.options)
      expect(asked).toEqual(['read'])
      expect(second.spawns).toEqual([])
      expect(second.actionRuns).toEqual([])
      expect(second.handoff.calls).toEqual([])
      expect(readFileSync(checkpoint).equals(before)).toBe(true)
      expect(first.handoff.calls).toHaveLength(pausesBefore)
      expect(result.exitCode).not.toBe(0)
    })
  }

  test('a checkpoint resumed on its own agent continues', async () => {
    const runtimeDir = scratchDir('recovery-resume-same-')
    const first = stubRun('codex', runtimeDir, () => provenanceFor('codex'))
    await runEngine(first.options)
    const second = stubRun('codex', runtimeDir, () => provenanceFor('codex'))
    await runEngine(second.options)
    expect(second.actionRuns.length).toBeGreaterThan(0)
    expect(second.actionRuns).not.toContain('prepare-run')
  })
})

// --- tool hosts at the dispatch boundary -----------------------------------------------

const okContext = (onPublish: () => void = () => {}): DevToolContext =>
  ({
    publishChanges: async () => {
      onPublish()
      return { ok: true, result: { pushedHead: 'head-1' } }
    },
    runChecks: async () => ({ ok: true, result: { passed: true, output: 'all green' } }),
    readSource: async () => ({
      ok: true,
      result: {
        notice: READ_SOURCE_NOTICE,
        sourceId: 'docs/x.md',
        manifestDigest: 'sha256:m',
        digest: 'sha256:d',
        finalUrl: null,
        snapshotRef: 'git:blob:1',
        length: 6,
        offset: 0,
        nextOffset: null,
        content: 'source'
      }
    })
  }) as unknown as DevToolContext

/** Opens a connection to `socketPath`; `call` sends one tools/call on it and resolves with its result. */
function connect(socketPath: string): Promise<{
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean }>
  end: () => void
}> {
  return new Promise((resolveConnection, reject) => {
    const socket = net.connect(socketPath)
    const pending = new Map<number, (result: { isError?: boolean }) => void>()
    let buffer = ''
    let id = 0
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let idx = buffer.indexOf('\n'); idx !== -1; idx = buffer.indexOf('\n')) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim() === '') continue
        const message = JSON.parse(line) as { id: number; result: { isError?: boolean } }
        pending.get(message.id)?.(message.result)
      }
    })
    socket.on('connect', () =>
      resolveConnection({
        call: (name, args = {}) =>
          new Promise((done) => {
            id += 1
            pending.set(id, done)
            socket.write(
              `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`
            )
          }),
        end: () => socket.end()
      })
    )
  })
}

const ROLE_HOSTS = [
  { role: 'developer', step: 'develop' },
  { role: 'code-reviewer', step: 'code-review' },
  { role: 'security', step: 'security-review' }
] as const

/** A short socket path: a unix socket path has a small byte limit. */
const socketIn = (dir: string, name: string) => join(dir, `${name}.sock`)

describe('tool hosts', () => {
  for (const { role, step } of ROLE_HOSTS) {
    test(`a socket deleted between dispatches is replaced before the next dispatch (${role})`, async () => {
      const dir = mkdtempSync('/tmp/rh-')
      scratch.push(dir)
      const socketPath = socketIn(dir, 'h')
      const capabilities = createDispatchCapabilityTable()
      const timeline: string[] = []
      const host = await startReplaceableDevToolsHost(
        { socketPath, serverVersion: 'test', context: okContext(), role, capabilities },
        {
          start: async (options) => {
            timeline.push('start')
            const started = await startDevToolsHost(options)
            return {
              close: async () => {
                timeline.push('close')
                await started.close()
                timeline.push('closed')
              }
            }
          }
        }
      )
      try {
        const dispatches: Partial<Record<'developer' | 'reviewer' | 'security', RoleDispatches>> = {
          [role === 'developer' ? 'developer' : role === 'code-reviewer' ? 'reviewer' : 'security']: {
            capabilities: {
              ...capabilities,
              mint: (ttl: number) => {
                timeline.push('mint')
                return capabilities.mint(ttl)
              }
            },
            ttlMs: 60_000,
            writeShim: () => {},
            onEnded: (capability: string) => host.noteDispatchEnded(capability)
          }
        }
        const generated = join(dir, 'generated')
        const roleDir =
          role === 'developer' ? 'developer' : role === 'code-reviewer' ? 'code-reviewer' : 'security-reviewer'
        mkdirSync(join(generated, roleDir), { recursive: true })
        const spawn = withDispatchCapabilities(() => stubAgent([]), generated, dispatches)
        const prompts = withToolHostBoundaries({}, { [step]: { role, host } }, () => {})
        // A temp sweep removes the socket file between two dispatches.
        rmSync(socketPath)
        expect(existsSync(socketPath)).toBe(false)
        timeline.length = 0
        await prompts[step]!('prompt', {})
        const child = spawn('claude', ['--settings', join(generated, roleDir, 'role-settings.json')], {
          cwd: dir,
          env: {}
        })
        // Closed and awaited before the replacement listens, and the capability minted only after it.
        expect(timeline).toEqual(['close', 'closed', 'start', 'mint'])
        expect(existsSync(socketPath)).toBe(true)
        const connection = await connect(socketPath)
        // The connection comes from this process, so the call carries a capability bound to it.
        const own = capabilities.mint(60_000)
        capabilities.bind(own, process.pid)
        const result =
          role === 'developer'
            ? await connection.call('run_checks', { [DISPATCH_CAPABILITY_ARGUMENT]: own })
            : await connection.call('read_source', { sourceId: 'docs/x.md', [DISPATCH_CAPABILITY_ARGUMENT]: own })
        connection.end()
        expect(result.isError).toBe(false)
        child.kill()
      } finally {
        await host.close()
      }
    })
  }

  test('a socket deleted mid-turn with the connection open: the publication completes', async () => {
    const dir = mkdtempSync('/tmp/rh-')
    scratch.push(dir)
    const socketPath = socketIn(dir, 'h')
    let published = 0
    const host = await startReplaceableDevToolsHost({
      socketPath,
      serverVersion: 'test',
      context: okContext(() => (published += 1)),
      role: 'developer'
    })
    try {
      const connection = await connect(socketPath)
      rmSync(socketPath)
      const result = await connection.call('publish_changes', { header: 'Fix: a thing' })
      connection.end()
      expect(result.isError).toBe(false)
      expect(published).toBe(1)
      // The turn is still running: nothing replaces the host until its next dispatch boundary.
      expect(existsSync(socketPath)).toBe(false)
    } finally {
      await host.close()
    }
  })

  test('a socket deleted mid-turn before the bridge connects: one re-dispatch, no repeated effect, then a named stop', async () => {
    const dir = mkdtempSync('/tmp/rh-')
    scratch.push(dir)
    const socketPath = socketIn(dir, 'h')
    const capabilities = createDispatchCapabilityTable()
    let published = 0
    const host = await startReplaceableDevToolsHost({
      socketPath,
      serverVersion: 'test',
      context: okContext(() => (published += 1)),
      role: 'developer',
      capabilities
    })
    const narrated: string[] = []
    const prompts = withToolHostBoundaries({}, { develop: { role: 'developer', host } }, (line) => narrated.push(line))
    try {
      // Dispatch 1: the socket is removed before its bridge connects, so its connect fails and nothing is published.
      await prompts.develop!('prompt', {})
      const first = capabilities.mint(60_000)
      capabilities.bind(first, process.pid)
      rmSync(socketPath)
      await expect(connect(socketPath)).rejects.toThrow()
      expect(host.noteDispatchEnded(first)).toBe(true)
      // The re-dispatch at the next boundary: the host is replaced, and the turn's one publication lands once.
      await prompts.develop!('prompt', {})
      expect(narrated.some((line) => line.includes('replaced it on the same path'))).toBe(true)
      const second = capabilities.mint(60_000)
      capabilities.bind(second, process.pid)
      const connection = await connect(socketPath)
      const result = await connection.call('publish_changes', {
        header: 'Fix: a thing',
        [DISPATCH_CAPABILITY_ARGUMENT]: second
      })
      connection.end()
      expect(result.isError).toBe(false)
      expect(host.noteDispatchEnded(second)).toBe(false)
      expect(published).toBe(1)
      // A role whose dispatches lose the socket twice in a row is not dispatched again: the run stops, named.
      for (let lost = 0; lost < MAX_TOOL_HOST_LOSSES; lost += 1) {
        await prompts.develop!('prompt', {})
        const capability = capabilities.mint(60_000)
        rmSync(socketPath)
        expect(host.noteDispatchEnded(capability)).toBe(true)
      }
      await expect(prompts.develop!('prompt', {})).rejects.toThrow('lost its socket during 2 dispatches in a row')
      expect(published).toBe(1)
    } finally {
      await host.close()
    }
  })

  test.todo('a dead dev-tools bridge fails a Codex start loudly')
})
