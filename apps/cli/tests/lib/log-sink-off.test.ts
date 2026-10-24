import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLogSink,
  LOG_FOLDER_ONLY_ENV,
  resolveLogDestinationFrom,
  type LogSinkDeps
} from '../../src/lib/log-sink.js'
import { VinayaConfigSchema, type VinayaConfig } from '../../src/lib/config.js'
import { configureEngineLogEnvironment, createEngineLogSink } from '../../../../processes/vinaya/bin/run-engine.js'
import { buildCheckEnv } from '../../src/checks/runner.js'
import { spawnBudgetedAsync, stripVinayaEnv } from './process-fixture.js'

const EVENT = {
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'test',
  effect_id: 'test',
  prompt_hash: 'sha256:test'
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(config: VinayaConfig) {
  const root = mkdtempSync(join(tmpdir(), 'log-off-'))
  roots.push(root)
  const folder = join(root, 'logs')
  const outbox = join(root, 'outbox')
  let serverDestinations = 0
  const deps: Partial<LogSinkDeps> = {
    readConfig: () => config,
    outboxRoot: () => outbox,
    home: () => root,
    cwd: () => root,
    env: () => ({ VINAYA_TASK: '42', VINAYA_ROLE: 'developer' }),
    resolveRepo: async () => ({ owner: 'example', repo: 'test' }),
    vinayaVersion: () => 'test',
    stderr: () => {},
    resolveLogDestination: (_repo, env, folderOnly) => {
      const destination = resolveLogDestinationFrom({
        localConfig: config,
        trustAnchorConfig: config,
        unattended: true,
        env,
        defaultFolder: folder,
        folderOnly
      })
      if (destination.kind === 'server') serverDestinations++
      return destination
    },
    unresolvedLogDestination: () => ({ kind: 'folder', folder })
  }
  return { root, folder, outbox, deps, serverDestinations: () => serverDestinations }
}

describe('Log recording restrictions', () => {
  it('accepts false and refuses true at config load', () => {
    expect(VinayaConfigSchema.parse({ logs: false }).logs).toBe(false)
    expect(VinayaConfigSchema.safeParse({ logs: true }).success).toBe(false)
  })

  for (const factory of [createLogSink, createEngineLogSink]) {
    it(`logs false disables async and synchronous recording through ${factory.name}`, async () => {
      const test = fixture({ logs: false })
      let destinationCalls = 0
      const sink = factory({
        ...test.deps,
        resolveLogDestination: () => {
          destinationCalls++
          return { kind: 'server', url: 'http://127.0.0.1:1' }
        }
      })
      sink.logSync(EVENT)
      sink.log(EVENT)
      await sink.drain()
      sink.logSync(EVENT)
      expect(destinationCalls).toBe(0)
      expect(existsSync(test.folder)).toBe(false)
      expect(existsSync(test.outbox)).toBe(false)
      expect(test.serverDestinations()).toBe(0)
    })
  }

  it('disabled recording wins over a worker spool and every destination', () => {
    const result = resolveLogDestinationFrom({
      localConfig: { logs: false },
      trustAnchorConfig: { logs: { url: 'https://logs.example.com' } },
      unattended: true,
      env: { VINAYA_LOG_SPOOL_DIR: '/spool' },
      defaultFolder: '/logs',
      folderOnly: true
    })
    expect(result.kind).toBe('none')
  })

  it('Engine delivers to a configured server destination through the shared sink', async () => {
    const requests: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push(await req.text())
        return new Response('ok')
      }
    })
    try {
      const root = mkdtempSync(join(tmpdir(), 'engine-log-server-'))
      roots.push(root)
      const url = `http://127.0.0.1:${server.port}/ingest`
      const sinkPath = join(import.meta.dir, '../../src/lib/log-sink.ts')
      const runnerPath = join(import.meta.dir, '../../../../processes/vinaya/bin/run-engine.ts')
      const script = join(root, 'engine-sink.ts')
      writeFileSync(
        script,
        `
          import { resolveLogDestinationFrom } from ${JSON.stringify(sinkPath)}
          import { createEngineLogSink } from ${JSON.stringify(runnerPath)}
          const config = { logs: { url: ${JSON.stringify(url)} } }
          const sink = createEngineLogSink({
            readConfig: () => config,
            env: () => ({ VINAYA_TASK: '42', VINAYA_ROLE: 'developer' }),
            resolveRepo: async () => ({ owner: 'example', repo: 'test' }),
            resolveLogDestination: (_repo, env, folderOnly) =>
              resolveLogDestinationFrom({
                localConfig: config,
                trustAnchorConfig: config,
                unattended: true,
                env,
                defaultFolder: ${JSON.stringify(join(root, 'logs'))},
                folderOnly
              })
          })
          sink.log(${JSON.stringify(EVENT)})
          await sink.drain()
          await new Promise((r) => setTimeout(r, 400))
        `
      )
      const result = await spawnBudgetedAsync([process.execPath, script], {
        cwd: root,
        env: { ...stripVinayaEnv(), HOME: root, AEG_REPO: 'example/test' }
      })
      expect(result.status).toBe(0)
      expect(requests.join('\n')).toContain('"effect_id":"test"')
      expect(existsSync(join(root, 'logs'))).toBe(false)
    } finally {
      server.stop()
    }
  })

  it('keeps a configured local folder when a sink restricts server delivery', () => {
    const result = resolveLogDestinationFrom({
      localConfig: { logs: { folder: '/local/logs' } },
      trustAnchorConfig: { logs: { folder: '/local/logs' } },
      unattended: true,
      env: {},
      defaultFolder: '/default',
      folderOnly: true
    })
    expect(result).toEqual({ kind: 'folder', folder: '/local/logs' })
  })

  it('check children inherit a folder-only restriction even when their declared env tries to relax it', () => {
    expect(buildCheckEnv(undefined, { [LOG_FOLDER_ONLY_ENV]: '1' })).toEqual({ [LOG_FOLDER_ONLY_ENV]: '1' })
    expect(buildCheckEnv({ [LOG_FOLDER_ONLY_ENV]: '0' }, { [LOG_FOLDER_ONLY_ENV]: '1' })[LOG_FOLDER_ONLY_ENV]).toBe('1')
    expect(buildCheckEnv(undefined, {})).toEqual({})
  })

  it('Engine runs leave their CLI children free to resolve the configured destination', () => {
    const env: NodeJS.ProcessEnv = { [LOG_FOLDER_ONLY_ENV]: '1' }
    configureEngineLogEnvironment(env)
    expect(env[LOG_FOLDER_ONLY_ENV]).toBeUndefined()
    expect(buildCheckEnv(undefined, env)[LOG_FOLDER_ONLY_ENV]).toBeUndefined()
  })
})
