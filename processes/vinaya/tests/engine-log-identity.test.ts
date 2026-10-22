import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import { setEngineLogIdentity } from '../bin/engine-log-identity'

test('stamps the loaded Vinaya process and installed Engine version', () => {
  const loaded = loadProcess(resolve(import.meta.dir, '..'))
  const packagePath = createRequire(import.meta.url).resolve('@atta/engine/package.json')
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'))
  expect(typeof installed.version, packagePath).toBe('string')
  expect(installed.version.length, packagePath).toBeGreaterThan(0)
  const env: NodeJS.ProcessEnv = {}
  setEngineLogIdentity(loaded, env)
  expect(env).toEqual({
    VINAYA_PROCESS_ID: loaded.identity.id,
    VINAYA_PROCESS_VERSION: loaded.identity.version,
    VINAYA_PROCESS_DIGEST: loaded.digest,
    VINAYA_RUNNER_ID: 'atta-engine',
    VINAYA_RUNNER_VERSION: installed.version
  })
})
