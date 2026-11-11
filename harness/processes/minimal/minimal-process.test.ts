import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MemorySaver } from '@langchain/langgraph'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnFn, SpawnedProcessLike } from '@atta/executor-agent-spawn'
import {
  hasConfigProvider,
  installConfigProvider,
  uninstallConfigProvider
} from '../../kernel/config/loader/config-provider'
import { installCheckRegistry, installedCheckRegistry } from '../../kernel/gates/checks/registry'
import { installProcess } from '../../kernel/dev-process-socket/contract/install-process'
import type { ProcessIntegration } from '../../kernel/dev-process-socket/contract/process-integration'
import { loadProcess } from '../../kernel/dev-process-socket/loader/load-process'
import { loadDeferredLogSinkFactory, registerDeferredLogSinkFactory } from '../../kernel/log/deferred-sink-factory'
import { startProcessRun } from '../../kernel/loops/runtimes/atta-engine/run-process'
import { createActions } from './actions'

const FOLDER = import.meta.dir
const VINAYA_FOLDER = `${FOLDER.slice(0, FOLDER.lastIndexOf('/'))}/vinaya-strict/`

/** A scripted stand-in for the worker's agent: it records the prompt it is given and answers once. */
function standInAgent(prompts: string[]): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdoutListener: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: (chunk: string) => {
        prompts.push(chunk)
      },
      end: () => {
        setTimeout(() => {
          stdoutListener?.('{"type":"result","session_id":"stand-in-session"}\n')
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
    kill: () => {}
  }
}

// The kernel slots are process-wide: put back what the test process had installed.
let previousConfig: ReturnType<typeof uninstallConfigProvider>
let previousChecks: ReturnType<typeof installedCheckRegistry> | undefined
let previousLog: ReturnType<typeof loadDeferredLogSinkFactory>
beforeEach(() => {
  previousConfig = uninstallConfigProvider()
  try {
    previousChecks = installedCheckRegistry()
  } catch {
    previousChecks = undefined
  }
  previousLog = loadDeferredLogSinkFactory()
})
afterEach(() => {
  uninstallConfigProvider()
  if (previousConfig) installConfigProvider(previousConfig)
  if (previousChecks) installCheckRegistry(previousChecks)
  if (previousLog) {
    const restored = previousLog
    registerDeferredLogSinkFactory(() => restored)
  }
})

describe('the minimal second process', () => {
  test('loads through the kernel loader with every part the contract asks for', () => {
    const loaded = loadProcess(FOLDER)
    expect(loaded.identity.id).toBe('minimal')
    expect(loaded.identity.version).toBe('0.1.0')
    expect(loaded.flowKey).toBe('default')
    const provided = loaded.provided
    expect(provided).toBeDefined()
    expect(Object.keys(provided?.roles ?? {})).toEqual(['worker'])
    expect(provided?.roles.worker?.grants).toBe(join(FOLDER, 'roles/worker/grants.yaml'))
    expect(provided?.roles.worker?.outputSchema).toBe(join(FOLDER, 'roles/worker/output.schema.json'))
    expect(provided?.integration).toBe(join(FOLDER, 'integration.ts'))
  })

  test('no source of the process names the Vinaya folder', () => {
    const sources = readdirSync(FOLDER, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(ts|yaml|json|md)$/.test(file) && !file.endsWith('.test.ts'))
      .filter((file) => file !== 'README.md')
    expect(sources.length).toBeGreaterThan(0)
    const forbidden = ['vinaya', 'strict'].join('-')
    const offending = sources.filter((file) => readFileSync(join(FOLDER, file), 'utf8').includes(forbidden))
    expect(offending).toEqual([])
  })

  test('installs through the kernel install call and runs its flow to completion on the Engine', async () => {
    const loaded = loadProcess(FOLDER)
    const integration = (await import(loaded.provided?.integration as string)).default as ProcessIntegration

    installProcess(integration, ['log', 'config', 'checks'])
    expect(hasConfigProvider()).toBe(true)
    expect(installedCheckRegistry()).toEqual([])
    expect(loadDeferredLogSinkFactory()).toBeFunction()

    const prompts: string[] = []
    const spawned: string[] = []
    const spawnFn: SpawnFn = (command) => {
      spawned.push(command)
      return standInAgent(prompts)
    }

    // The test preload loads Vinaya modules before this body, so only what the run itself loads is compared.
    const before = new Set(Object.keys(require.cache))
    const outcome = await startProcessRun({
      process: loaded,
      question: 'what is the minimal process',
      bindings: {
        actions: createActions({ id: loaded.identity.id, version: loaded.identity.version }),
        decisions: {},
        roles: {
          worker: {
            command: 'stand-in-worker',
            buildArgs: () => ['--run'],
            allowedPermissions: ['roles/worker/grants.yaml']
          }
        }
      },
      checkpointer: new MemorySaver(),
      workingDirectoryRoot: mkdtempSync(join(tmpdir(), 'minimal-process-')),
      spawnFn
    })
    const loadedByTheRun = Object.keys(require.cache).filter((path) => !before.has(path))

    expect(outcome.reason).toBe('completed')
    if (outcome.reason !== 'completed') return
    expect(spawned).toEqual(['stand-in-worker'])
    expect(prompts.join('')).toContain('what is the minimal process')
    expect(outcome.checkpoint.results.begin).toBeDefined()
    expect(outcome.checkpoint.results.work).toBeDefined()

    // The run is this process's own: it records this process's id and version...
    const closing = outcome.checkpoint.results.close
    expect(closing && 'stdout' in closing ? closing.stdout : undefined).toBe('minimal@0.1.0')
    // ...and loads no module from the Vinaya folder.
    expect(loadedByTheRun.filter((path) => path.startsWith(VINAYA_FOLDER))).toEqual([])
  })
})
