import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parse } from 'yaml'
import type { LoadedProcess } from '../../../harness/dev-process/loader/load-process'

/** Stamp the loaded process, installed Engine and dispatched agent runtime identities before creating a Log sink. */
export function setEngineLogIdentity(
  loaded: LoadedProcess,
  runtime: string,
  env: NodeJS.ProcessEnv = process.env
): void {
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
  env.VINAYA_RUNTIME = runtime
  // Which flow ran: the Log's `flow.id` is the Flow file's own id, `flow.version` the key the run chose (v1, v2), so
  // two flows of one process are compared from the Log alone.
  env.VINAYA_FLOW = flowIdOf(loaded)
  env.VINAYA_FLOW_VERSION = loaded.flowKey
}

/** The `id` the chosen Flow file declares; the process id when the file names none. */
export function flowIdOf(loaded: LoadedProcess): string {
  try {
    const id = (parse(readFileSync(loaded.flowPath, 'utf8')) as { id?: unknown } | null)?.id
    return typeof id === 'string' && id !== '' ? id : loaded.identity.id
  } catch {
    return loaded.identity.id
  }
}
