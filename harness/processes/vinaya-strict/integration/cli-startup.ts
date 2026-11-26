import { registerDeferredLogSinkFactory } from '@harness/kernel/log/deferred-sink-factory.js'
import { registerCliVersionSource } from '@harness/kernel/log/run-identity.js'

/**
 * What the command-line program installs before any command: the check registry and the Log sink factory. The
 * program imports them from here, not from the dispatch module, so starting it loads only these. The factory is
 * registered deferred: the Log sink and its Vinaya factory load the first time something logs, never at startup.
 */
export { installVinayaCheckRegistry } from '../checks/registry.js'

type SinkFactoryModule = typeof import('./log/log-sink-factory.js')

export function installVinayaLogSinkFactory(): void {
  // The run recorder lives in the kernel, which cannot read the program's manifest; the version reaches it from here.
  registerCliVersionSource(() => (require('./log/log-sink-factory.js') as SinkFactoryModule).readVinayaVersion())
  registerDeferredLogSinkFactory(() => (require('./log/log-sink-factory.js') as SinkFactoryModule).createVinayaLogSink)
}
