/**
 * Vinaya's process integration: the one module `process.yaml` names at
 * `provides.integration`, implementing the kernel's `ProcessIntegration`
 * (`harness/kernel/dev-process-socket/contract/process-integration.ts`). It
 * gathers what Vinaya already supplies to each kernel slot — the check
 * registry (`checks/registry.ts`), the policies
 * (`integration/policies/vinaya-policies.ts`), the configuration provider and
 * section (`integration/config/compose.ts`, `vinaya-config-section.ts`) and
 * the Log sink factory (`integration/log/log-sink-factory.ts`) — and moves
 * none of them.
 *
 * Every member is a function, so importing this module builds no registry
 * and no policy. The Log sink factory alone loads its module when called, the
 * same deferred load the command line's startup uses, so the Log sink loads
 * the first time something logs.
 */

import type { ProcessIntegration } from '../../../../kernel/dev-process-socket/contract/process-integration.js'
import { coreCheckRegistry } from '../../checks/registry.js'
import { vinayaConfigProvider } from '../config/compose.js'

type LogSinkFactoryModule = typeof import('../log/log-sink-factory.js')
type PoliciesModule = typeof import('../policies/vinaya-policies.js')
type ConfigSectionModule = typeof import('../config/vinaya-config-section.js')

const logSinkFactory = (): LogSinkFactoryModule => require('../log/log-sink-factory.js') as LogSinkFactoryModule
// The policies and the configuration section load when called: a composition root that fills only the Log,
// configuration and check slots (the command line at start) loads neither.
const policies = (): PoliciesModule => require('../policies/vinaya-policies.js') as PoliciesModule
const configSection = (): ConfigSectionModule => require('../config/vinaya-config-section.js') as ConfigSectionModule

/**
 * Names the modules loaded by `require` above as dynamic imports, so the test selector — which does not follow
 * `require` — still reaches every test through them. Never called.
 */
export const lazyIntegrationModules = (): Promise<unknown>[] => [
  import('../policies/vinaya-policies.js'),
  import('../config/vinaya-config-section.js'),
  import('../log/log-sink-factory.js')
]

export const vinayaProcessIntegration: ProcessIntegration = {
  checks: () => coreCheckRegistry(),
  policies: {
    broker: () => policies().vinayaBrokerPolicies(),
    workerBoundary: () => policies().vinayaWorkerBoundaryPolicies(),
    taskToolRouter: () => policies().vinayaRouterPolicies(),
    toolGrants: () => policies().vinayaToolGrantPolicy()
  },
  config: {
    provider: () => vinayaConfigProvider,
    section: () => configSection().VINAYA_CONFIG_SECTION
  },
  log: {
    loadSinkFactory: () => logSinkFactory().createVinayaLogSink
  }
}
