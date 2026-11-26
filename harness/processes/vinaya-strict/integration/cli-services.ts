import { processHasLogDestination } from '../../../../apps/cli/src/lib/log-destination.js'

type InstallProcessModule = typeof import('@harness/kernel/dev-process-socket/contract/install-process.js')
type IntegrationModule = typeof import('./process/process-integration.js')
type ConfigProviderModule = typeof import('@harness/kernel/config/loader/config-provider.js')
type OutsideLogModule = typeof import('@harness/kernel/log/outside-log.js')
type OperationLogModule = typeof import('@harness/kernel/log/client/cli-operation-log.js')

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
  const kernel = require('@harness/kernel/dev-process-socket/contract/install-process.js') as InstallProcessModule
  const { vinayaProcessIntegration } = require('./process/process-integration.js') as IntegrationModule
  kernel.installProcess(vinayaProcessIntegration, ['log', 'config', 'checks'])
}

/**
 * Registers the exit record of this invocation, loading the Log client only when the process has a Log
 * destination: a synchronous exit handler cannot await an import, so the client loads here, once, or not at all.
 * The services install before the record is written, because the sink reads configuration through the provider.
 */
export function registerOperationRecord(argv: readonly string[]): void {
  if (!processHasLogDestination(process.env)) return
  const operationLog = require('@harness/kernel/log/client/cli-operation-log.js') as OperationLogModule
  operationLog.recordCliOperationAtExit(argv, {
    on: (event, handler) => process.on(event, handler),
    record: (record) => {
      installServices()
      // The invocation's settings are read as the process reads them, so a setting it ignores is reported once.
      ;(require('@harness/kernel/config/loader/config-provider.js') as ConfigProviderModule)
        .configProvider()
        .loadConfig()
      ;(require('@harness/kernel/log/outside-log.js') as OutsideLogModule).writeCommand(record)
    }
  })
}
