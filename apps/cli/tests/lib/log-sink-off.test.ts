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
import { createEngineLogSink } from '../../../../processes/vinaya/bin/run-engine.js'
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

  it('Engine writes local lines with a configured URL and leaves the server outbox empty', async () => {
    const test = fixture({ logs: { url: 'http://127.0.0.1:1' } })
    const sink = createEngineLogSink(test.deps)
    sink.log(EVENT)
    await sink.drain()
    sink.logSync(EVENT)
    expect(
      readFileSync(join(test.folder, 'example-test', '42.ndjson'), 'utf8')
        .trim()
        .split('\n')
    ).toHaveLength(2)
    expect(existsSync(test.outbox)).toBe(false)
    expect(test.serverDestinations()).toBe(0)
  })

  it('keeps a configured local folder when Engine restricts server delivery', () => {
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

  it('check children inherit the Engine restriction even when their declared env tries to relax it', () => {
    expect(buildCheckEnv(undefined, { [LOG_FOLDER_ONLY_ENV]: '1' })).toEqual({ [LOG_FOLDER_ONLY_ENV]: '1' })
    expect(buildCheckEnv({ [LOG_FOLDER_ONLY_ENV]: '0' }, { [LOG_FOLDER_ONLY_ENV]: '1' })[LOG_FOLDER_ONLY_ENV]).toBe('1')
    expect(buildCheckEnv(undefined, {})).toEqual({})
  })

  it('Engine run_checks subprocesses use ordinary shared sinks without server delivery or outbox writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-log-child-'))
    roots.push(root)
    writeFileSync(join(root, 'vinaya.config.json'), JSON.stringify({ logs: { url: 'http://127.0.0.1:1' } }))
    const sinkPath = join(import.meta.dir, '../../src/lib/log-sink.ts')
    const runnerPath = join(import.meta.dir, '../../../../processes/vinaya/bin/run-engine.ts')
    const checksPath = join(import.meta.dir, '../../../../harness/gates/run-checks.ts')
    const cli = join(root, 'fixture-cli.ts')
    writeFileSync(
      cli,
      `
        import { log, logSync, drainLogSink } from ${JSON.stringify(sinkPath)}
        let requests = 0
        globalThis.fetch = async () => { requests++; return new Response('ok') }
        if (process.argv.slice(2).join(' ') !== 'check --all') throw new Error('unexpected check argv')
        log(${JSON.stringify(EVENT)})
        await drainLogSink()
        logSync(${JSON.stringify(EVENT)})
        console.log(JSON.stringify({ requests }))
      `
    )
    const parent = join(root, 'engine-parent.ts')
    writeFileSync(
      parent,
      `
        import { configureEngineLogEnvironment } from ${JSON.stringify(runnerPath)}
        import { runCliChecks } from ${JSON.stringify(checksPath)}
        configureEngineLogEnvironment()
        const result = await runCliChecks(${JSON.stringify(cli)}, ${JSON.stringify(root)}, {})
        if (!result.passed) throw new Error(result.output)
        console.log(result.output)
      `
    )
    const result = await spawnBudgetedAsync([process.execPath, parent], {
      cwd: root,
      env: {
        ...stripVinayaEnv(),
        HOME: root,
        AEG_REPO: 'example/test',
        VINAYA_TASK: '42',
        VINAYA_RUNTIME_DIR: join(root, 'runtime')
      }
    })
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('Error')
    expect(readFileSync(join(root, 'runtime/logs/example-test/42.ndjson'), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(existsSync(join(root, '.vinaya/outbox'))).toBe(false)
    expect(result.stdout).toContain('"requests":0')
  })
})
