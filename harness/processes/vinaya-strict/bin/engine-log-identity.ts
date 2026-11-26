import { readFileSync } from 'node:fs'
import enginePackage from '@atta/engine/package.json' with { type: 'json' }
import { parse } from 'yaml'
import type { LoadedProcess } from '@harness/kernel/dev-process-socket/loader/load-process'

/**
 * The Engine's version, from a static import of its manifest the bundler inlines: an installed package carries the
 * Engine inside its bundle, with no `@atta/engine` folder to look up at run time.
 */
export const ENGINE_VERSION: string = enginePackage.version

/** Stamp the loaded process, installed Engine and dispatched agent runtime identities before creating a Log sink. */
export function setEngineLogIdentity(
  loaded: LoadedProcess,
  runtime: string,
  env: NodeJS.ProcessEnv = process.env,
  engineVersion: unknown = ENGINE_VERSION
): void {
  if (typeof engineVersion !== 'string' || engineVersion === '') {
    throw new Error('Cannot resolve the Engine version from the bundled @atta/engine manifest')
  }
  env.VINAYA_PROCESS_ID = loaded.identity.id
  env.VINAYA_PROCESS_VERSION = loaded.identity.version
  env.VINAYA_PROCESS_DIGEST = loaded.digest
  env.VINAYA_RUNNER_ID = 'atta-engine'
  env.VINAYA_RUNNER_VERSION = engineVersion
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
