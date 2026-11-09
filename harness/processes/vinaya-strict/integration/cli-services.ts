import { processHasLogDestination } from '../../../../apps/cli/src/lib/log-destination.js'

type StartupModule = typeof import('./cli-startup.js')
type ConfigComposeModule = typeof import('./config/compose.js')
type LogSinkModule = typeof import('../../../kernel/log/log-sink.js')
type OperationLogModule = typeof import('../../../kernel/log/client/cli-operation-log.js')

let servicesInstalled = false

/**
 * The composition root: the Log sink factory, the configuration provider kernel code reads configuration through,
 * and the check registry. They install the first time something needs them, never at startup, so a start that
 * runs `version` or prints help loads none of them. The Log client builds its default sink from the installed
 * factory, never on its own. This module imports none of them statically, so the program's entry can import it.
 */
export function installServices(): void {
  if (servicesInstalled) return
  servicesInstalled = true
  const startup = require('./cli-startup.js') as StartupModule
  const compose = require('./config/compose.js') as ConfigComposeModule
  startup.installVinayaLogSinkFactory()
  compose.installVinayaConfigProvider()
  startup.installVinayaCheckRegistry()
}

/**
 * Registers the exit record of this invocation, loading the Log client only when the process has a Log
 * destination: a synchronous exit handler cannot await an import, so the client loads here, once, or not at all.
 * The services install before the record is written, because the sink reads configuration through the provider.
 */
export function registerOperationRecord(argv: readonly string[]): void {
  if (!processHasLogDestination(process.env)) return
  const operationLog = require('../../../kernel/log/client/cli-operation-log.js') as OperationLogModule
  operationLog.recordCliOperationAtExit(argv, {
    on: (event, handler) => process.on(event, handler),
    logSync: (event, options) => {
      installServices()
      ;(require('../../../kernel/log/log-sink.js') as LogSinkModule).logSync(event, options)
    },
    now: Date.now,
    unattributedStream: operationLog.CLI_OPERATION_STREAM
  })
}
