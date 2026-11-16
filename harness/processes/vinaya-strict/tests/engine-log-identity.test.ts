import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import enginePackage from '@atta/engine/package.json' with { type: 'json' }
import { loadProcess } from '../../../../harness/kernel/dev-process-socket/loader/load-process'
import { ENGINE_VERSION, setEngineLogIdentity } from '../bin/engine-log-identity'

test('stamps the loaded Vinaya process, installed Engine version and dispatched agent runtime', () => {
  const loaded = loadProcess(resolve(import.meta.dir, '..'))
  expect(typeof enginePackage.version).toBe('string')
  expect(enginePackage.version.length).toBeGreaterThan(0)
  const env: NodeJS.ProcessEnv = {}
  setEngineLogIdentity(loaded, 'codex', env)
  expect(env).toEqual({
    VINAYA_PROCESS_ID: loaded.identity.id,
    VINAYA_PROCESS_VERSION: loaded.identity.version,
    VINAYA_PROCESS_DIGEST: loaded.digest,
    VINAYA_RUNNER_ID: 'atta-engine',
    VINAYA_RUNNER_VERSION: enginePackage.version,
    VINAYA_RUNTIME: 'codex',
    VINAYA_FLOW: 'vinaya-dev-review-v2',
    VINAYA_FLOW_VERSION: 'v2'
  })
})

test('stamps the Engine version its manifest declares', () => {
  expect(ENGINE_VERSION).toBe(enginePackage.version)
})

test('refuses to stamp a run whose Engine version is empty', () => {
  const loaded = loadProcess(resolve(import.meta.dir, '..'))
  const env: NodeJS.ProcessEnv = {}
  expect(() => setEngineLogIdentity(loaded, 'codex', env, '')).toThrow('Engine version')
  expect(env).toEqual({})
})

test('a run that chose a flow stamps that flow file id and key as the Log flow identity', () => {
  const folder = resolve(import.meta.dir, '..')
  const loaded = loadProcess(folder)
  const env: NodeJS.ProcessEnv = {}
  setEngineLogIdentity({ ...loaded, flowKey: 'v9', identity: { ...loaded.identity } }, 'claude', env)
  expect(env.VINAYA_FLOW_VERSION).toBe('v9')
  expect(env.VINAYA_FLOW).toBe('vinaya-dev-review-v2')
})
