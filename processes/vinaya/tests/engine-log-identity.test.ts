import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import { setEngineLogIdentity } from '../bin/engine-log-identity'

test('stamps the loaded Vinaya process, installed Engine version and dispatched agent runtime', () => {
  const loaded = loadProcess(resolve(import.meta.dir, '..'))
  const packagePath = createRequire(import.meta.url).resolve('@atta/engine/package.json')
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'))
  expect(typeof installed.version, packagePath).toBe('string')
  expect(installed.version.length, packagePath).toBeGreaterThan(0)
  const env: NodeJS.ProcessEnv = {}
  setEngineLogIdentity(loaded, 'codex', env)
  expect(env).toEqual({
    VINAYA_PROCESS_ID: loaded.identity.id,
    VINAYA_PROCESS_VERSION: loaded.identity.version,
    VINAYA_PROCESS_DIGEST: loaded.digest,
    VINAYA_RUNNER_ID: 'atta-engine',
    VINAYA_RUNNER_VERSION: installed.version,
    VINAYA_RUNTIME: 'codex',
    VINAYA_FLOW: 'vinaya-dev-review',
    VINAYA_FLOW_VERSION: 'v1'
  })
})

test('a run that chose a flow stamps that flow file id and key as the Log flow identity', () => {
  const folder = resolve(import.meta.dir, '..')
  const loaded = loadProcess(folder)
  const env: NodeJS.ProcessEnv = {}
  setEngineLogIdentity({ ...loaded, flowKey: 'v9', identity: { ...loaded.identity } }, 'claude', env)
  expect(env.VINAYA_FLOW_VERSION).toBe('v9')
  expect(env.VINAYA_FLOW).toBe('vinaya-dev-review')
})
