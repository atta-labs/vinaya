import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { LoadedProcess } from '../../../harness/dev-process/loader/load-process'

/** Stamp the loaded process and installed Engine identities before creating a Log sink. */
export function setEngineLogIdentity(loaded: LoadedProcess, env: NodeJS.ProcessEnv = process.env): void {
  const packagePath = createRequire(import.meta.url).resolve('@atta/engine/package.json')
  const pkg: unknown = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (
    typeof pkg !== 'object' ||
    pkg === null ||
    !('version' in pkg) ||
    typeof pkg.version !== 'string' ||
    pkg.version === ''
  ) {
    throw new Error(`Cannot resolve Engine version from ${packagePath}`)
  }
  env.VINAYA_PROCESS_ID = loaded.identity.id
  env.VINAYA_PROCESS_VERSION = loaded.identity.version
  env.VINAYA_PROCESS_DIGEST = loaded.digest
  env.VINAYA_RUNNER_ID = 'atta-engine'
  env.VINAYA_RUNNER_VERSION = pkg.version
}
