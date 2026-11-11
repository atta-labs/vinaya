import type { ProcessAction } from '../../kernel/loops/runtimes/atta-engine/run-process'

/** The process identity a run records: the id and version its `process.yaml` declares. */
export interface MinimalIdentity {
  id: string
  version: string
}

/**
 * The mechanical actions the Flow names. `minimal.close` reports the identity it was built with as its
 * output, so the finished run carries the process id and version that ran it.
 */
export function createActions(identity: MinimalIdentity): Readonly<Record<string, ProcessAction>> {
  return {
    'minimal.begin': () => ({ exitCode: 0, stdout: 'begun' }),
    'minimal.close': () => ({ exitCode: 0, stdout: `${identity.id}@${identity.version}` })
  }
}
