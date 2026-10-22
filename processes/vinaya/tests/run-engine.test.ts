import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import type { ActionRegistry } from '../../../harness/dev-process/engine-runtime/run-process'
import type { NodeLifecycle } from '../../../harness/dev-process/logging/translate'
import { devToolsSocketPath } from '../../../apps/cli/src/lib/task-tools/dev-tools-registration'
import { classifyGateResult, dispatchReviewers, type TaskInput } from '../executing/actions'
import { dryRunLines, parseArgs, runEngine, shimContent, type EngineRunOptions, type RunTrace } from '../bin/run-engine'

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

function stubAgent(role: string, lines: string[]): SpawnedProcessLike {
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
