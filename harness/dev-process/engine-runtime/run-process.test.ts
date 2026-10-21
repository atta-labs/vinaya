import { describe, expect, test } from 'bun:test'
import { MemorySaver } from '@langchain/langgraph'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRunControl,
  type RoleBinaryConfig,
  type SpawnFn,
  type SpawnedProcessLike
} from '@atta/executor-agent-spawn'
import type { GeneratedAgentConfig } from '../../adapters/agents/policy'
import { loadProcess } from '../loader/load-process'
import {
  createRoleLauncher,
  resumeProcessRun,
  startProcessRun,
  type ProcessBindings,
  type ProcessRunOptions
} from './run-process'

// A sample process with one mechanical step, one agent step and one decision
// that loops back to the agent step once.
const FLOW = `schema_version: "2.0"
id: sample-flow
display_name: Sample
description: Sample flow.
experimental: true
benchmarked: false
defaults:
  model: process-supplied
agents:
  - role: worker
steps:
  - { id: prepare, type: mechanical, action: sample.prepare }
  - id: work
    type: agent
    role: worker
    prompt_template: "Work on {{question}}."
    permission: worker/grants.yaml
    working_directory: "."
    max_turns: 5
  - id: check
    type: mechanical
    action: sample.check
    decision: { examine: work, if_true: work, if_false: finish, max_revisions: 2 }
  - { id: finish, type: mechanical, action: sample.finish }
`

function sampleProcess() {
  const folder = mkdtempSync(join(tmpdir(), 'engine-runtime-'))
  mkdirSync(join(folder, 'worker'))
  writeFileSync(join(folder, 'worker', 'grants.yaml'), 'role: worker\n')
  writeFileSync(join(folder, 'flow.yaml'), FLOW)
  writeFileSync(join(folder, 'process.yaml'), 'id: sample\nversion: "1"\nflow: flow.yaml\nroles:\n  - worker\n')
  return { folder, loaded: loadProcess(folder) }
}

function fakeAgentProcess(onKill: () => void): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdoutListener: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () => {
        setTimeout(() => {
          stdoutListener?.('{"type":"result","session_id":"s1"}\n')
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: {
      on: (_event, listener) => {
        stdoutListener = listener as (chunk: string) => void
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

function harness(overrides: Partial<ProcessBindings> = {}) {
  const calls: Record<string, number> = {}
  const spawned: string[] = []
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  const step = (name: string) => {
    count(name)
    return { exitCode: 0 }
  }
  const role: RoleBinaryConfig = {
    command: 'worker-agent',
    buildArgs: () => ['--run'],
    allowedPermissions: ['worker/grants.yaml']
  }
  const checks: number[] = [1, 0]
  const bindings: ProcessBindings = {
    actions: {
      'sample.prepare': () => step('prepare'),
      'sample.check': () => step('check'),
      'sample.finish': () => step('finish')
    },
    decisions: { check: () => (checks.shift() ?? 0) !== 0 },
    roles: { worker: role },
    ...overrides
  }
  const spawnFn: SpawnFn = (command) => {
    spawned.push(command)
    return fakeAgentProcess(() => {})
  }
  const { folder, loaded } = sampleProcess()
  const options: ProcessRunOptions = {
    process: loaded,
    question: 'the sample',
    bindings,
    checkpointer: new MemorySaver(),
    workingDirectoryRoot: folder,
    spawnFn
  }
  return { options, calls, spawned }
}

function* filesUnder(path: string): Generator<string> {
  for (const entry of readdirSync(path)) {
    const full = join(path, entry)
    if (statSync(full).isDirectory()) yield* filesUnder(full)
    else yield full
  }
}

describe('engine runtime', () => {
  test('no file under the engine runtime names a particular process', () => {
    const forbidden = new RegExp(['vi', 'naya'].join(''), 'i')
    const offending = [...filesUnder(import.meta.dir)].filter((file) => forbidden.test(readFileSync(file, 'utf8')))
    expect(offending).toEqual([])
  })

  test('runs the Flow through the packed executor, looping back once', async () => {
    const { options, calls, spawned } = harness()
    const outcome = await startProcessRun(options)
    expect(outcome.reason).toBe('completed')
    expect(spawned).toEqual(['worker-agent', 'worker-agent'])
    expect(calls).toEqual({ prepare: 1, check: 2, finish: 1 })
  })

  test('a halt pauses the run and a resume on the same checkpointer does not replay finished steps', async () => {
    const control = createRunControl()
    const { options, calls } = harness()
    options.bindings = {
      ...options.bindings,
      actions: {
        ...options.bindings.actions,
        'sample.prepare': () => {
          control.halt('stop')
          calls.prepare = (calls.prepare ?? 0) + 1
          return { exitCode: 0 }
        }
      }
    }
    options.control = control
    const paused = await startProcessRun(options)
    expect(paused.reason).toBe('paused')
    const resumed = await resumeProcessRun({ ...options, control: undefined }, paused.identity)
    expect(resumed.reason).toBe('completed')
    expect(calls.prepare).toBe(1)
  })

  test('a Flow action with no registry entry is refused by name before any step runs', async () => {
    const { options, calls, spawned } = harness()
    const { 'sample.check': _omitted, ...actions } = options.bindings.actions
    options.bindings = { ...options.bindings, actions }
    await expect(startProcessRun(options)).rejects.toThrow('sample.check')
    expect(calls).toEqual({})
    expect(spawned).toEqual([])
  })

  test('a Flow role with no launcher is refused by name before any step runs', async () => {
    const { options, calls, spawned } = harness({ roles: {} })
    await expect(startProcessRun(options)).rejects.toThrow('worker')
    expect(calls).toEqual({})
    expect(spawned).toEqual([])
  })

  test('a Flow decision with no registry entry is refused by name before any step runs', async () => {
    const { options, calls, spawned } = harness({ decisions: {} })
    await expect(startProcessRun(options)).rejects.toThrow('Decision "check"')
    expect(calls).toEqual({})
    expect(spawned).toEqual([])
  })

  test('the role launcher writes the adapter files and launches with the adapter argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-launcher-'))
    const generated: GeneratedAgentConfig = {
      vendor: 'claude-code',
      launch: ['agent', '-p', '--settings', 'role.json'],
      env: { HOME_HINT: 'x' },
      files: { 'role.json': '{}\n', 'hooks/pre.mjs': '// hook\n' },
      executableFiles: ['hooks/pre.mjs']
    }
    const launcher = createRoleLauncher(generated, { generatedDir: dir, allowedPermissions: ['worker/grants.yaml'] })
    expect(launcher.command).toBe('agent')
    expect(launcher.buildArgs({ permission: 'worker/grants.yaml', maxTurns: 1 })).toEqual([
      '-p',
      '--settings',
      'role.json'
    ])
    expect(launcher.env).toEqual({ HOME_HINT: 'x' })
    expect(readFileSync(join(dir, 'role.json'), 'utf8')).toBe('{}\n')
    expect(statSync(join(dir, 'hooks/pre.mjs')).mode & 0o111).not.toBe(0)
  })
})
